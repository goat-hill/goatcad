import { describe, test, expect } from 'vitest'
import type { GitFileStatus } from '../../../../preload/gitTypes'
import { buildTreeDecorations, decorationFor } from '../gitDecorations'

const file = (over: Partial<GitFileStatus> & { path: string }): GitFileStatus => ({
  relPath: over.path.replace(/^\//, ''),
  index: null,
  worktree: 'M',
  conflicted: false,
  untracked: false,
  ...over
})

describe('decorationFor', () => {
  test('derives the VSCode-style letter and color class', () => {
    expect(decorationFor(file({ path: '/p/a', worktree: 'M' }))).toEqual({
      letter: 'M',
      cls: 'git-modified'
    })
    expect(decorationFor(file({ path: '/p/a', untracked: true, worktree: null }))).toEqual({
      letter: 'U',
      cls: 'git-added'
    })
    expect(decorationFor(file({ path: '/p/a', index: 'A', worktree: null }))).toEqual({
      letter: 'A',
      cls: 'git-added'
    })
    expect(decorationFor(file({ path: '/p/a', index: 'R', worktree: null }))).toEqual({
      letter: 'R',
      cls: 'git-modified'
    })
    expect(decorationFor(file({ path: '/p/a', index: 'C', worktree: null }))).toEqual({
      letter: 'R',
      cls: 'git-modified'
    })
    expect(decorationFor(file({ path: '/p/a', worktree: 'D' }))).toEqual({
      letter: 'D',
      cls: 'git-deleted'
    })
    expect(decorationFor(file({ path: '/p/a', index: 'D', worktree: null }))).toEqual({
      letter: 'D',
      cls: 'git-deleted'
    })
    expect(
      decorationFor(file({ path: '/p/a', conflicted: true, index: 'U', worktree: 'U' }))
    ).toEqual({ letter: '!', cls: 'git-conflict' })
  })

  test('conflict outranks untracked and staged states', () => {
    expect(decorationFor(file({ path: '/p/a', conflicted: true, index: 'A' })).letter).toBe('!')
  })

  test('staged-and-modified shows as modified (worktree side wins the tree badge)', () => {
    expect(decorationFor(file({ path: '/p/a', index: 'M', worktree: 'M' }))).toEqual({
      letter: 'M',
      cls: 'git-modified'
    })
  })
})

describe('buildTreeDecorations', () => {
  test('maps files and tints every ancestor directory below the project root', () => {
    const deco = buildTreeDecorations('/home/u/proj', [
      file({ path: '/home/u/proj/boards/amp/main.kicad_pcb' })
    ])
    expect(deco.files.get('/home/u/proj/boards/amp/main.kicad_pcb')?.letter).toBe('M')
    expect(deco.dirs.get('/home/u/proj/boards/amp')).toBe('git-modified')
    expect(deco.dirs.get('/home/u/proj/boards')).toBe('git-modified')
    expect(deco.dirs.has('/home/u/proj')).toBe(false)
    expect(deco.dirs.has('/home/u')).toBe(false)
  })

  test('a conflicted descendant promotes the folder tint to conflict', () => {
    const deco = buildTreeDecorations('/p', [
      file({ path: '/p/sub/a.txt' }),
      file({ path: '/p/sub/b.txt', conflicted: true })
    ])
    expect(deco.dirs.get('/p/sub')).toBe('git-conflict')
  })

  test('conflict tint is not downgraded by a later plain change', () => {
    const deco = buildTreeDecorations('/p', [
      file({ path: '/p/sub/b.txt', conflicted: true }),
      file({ path: '/p/sub/a.txt' })
    ])
    expect(deco.dirs.get('/p/sub')).toBe('git-conflict')
  })

  test('deleted-only descendants still tint their folder', () => {
    const deco = buildTreeDecorations('/p', [file({ path: '/p/gone/x.txt', worktree: 'D' })])
    expect(deco.dirs.get('/p/gone')).toBe('git-modified')
  })

  test('files outside the project folder decorate but add no dir tints', () => {
    const deco = buildTreeDecorations('/repo/proj', [file({ path: '/repo/other/x.txt' })])
    expect(deco.files.has('/repo/other/x.txt')).toBe(true)
    expect(deco.dirs.size).toBe(0)
  })

  test('backslash paths normalize to forward slashes', () => {
    const deco = buildTreeDecorations('C:\\work\\proj', [
      file({ path: 'C:\\work\\proj\\sub\\a.kicad_sch' })
    ])
    expect(deco.files.get('C:/work/proj/sub/a.kicad_sch')?.letter).toBe('M')
    expect(deco.dirs.get('C:/work/proj/sub')).toBe('git-modified')
  })

  test('a project path with a trailing slash still excludes the root itself', () => {
    const deco = buildTreeDecorations('/p/', [file({ path: '/p/sub/a.txt' })])
    expect(deco.dirs.get('/p/sub')).toBe('git-modified')
    expect(deco.dirs.has('/p')).toBe(false)
  })
})
