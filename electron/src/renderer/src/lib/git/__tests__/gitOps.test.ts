import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import type { GitFileStatus, GitStatusResult } from '../../../../../preload/gitTypes'
import { createGitOps, followedDiffTabs, type GitOps } from '../gitOps'
import { diffTabPath } from '../../tabs'
import { gitRemoteErrorKey } from '../gitCopy'

const file = (over: Partial<GitFileStatus> & { path: string }): GitFileStatus => ({
  relPath: over.path.slice(1),
  index: null,
  worktree: 'M',
  conflicted: false,
  untracked: false,
  ...over
})

const status = (files: GitFileStatus[]): GitStatusResult => ({ state: 'ok', files })

const api = {
  gitCommit: vi.fn(async () => ({ success: true })),
  gitPush: vi.fn(async () => ({ success: true })),
  gitPull: vi.fn(async () => ({ success: false, failure: 'diverged', error: 'nope' })),
  gitStage: vi.fn(async () => ({ success: true }))
}

beforeEach(() => {
  vi.stubGlobal('window', { api })
  for (const fn of Object.values(api)) fn.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

interface Harness {
  git: GitOps
  hooks: { refresh: ReturnType<typeof vi.fn>; worktreeChanged: ReturnType<typeof vi.fn> }
}

const ops = (files: GitFileStatus[]): Harness => {
  const hooks = { refresh: vi.fn(async () => {}), worktreeChanged: vi.fn(async () => {}) }
  return { git: createGitOps(ref(status(files)), ref('/p'), hooks), hooks }
}

describe('createGitOps', () => {
  test('commits only the staged changes when something is staged', async () => {
    const { git } = ops([file({ path: '/a', index: 'M', worktree: null }), file({ path: '/b' })])
    expect(await git.commit('msg')).toBe(true)
    expect(api.gitCommit).toHaveBeenCalledWith('/p', 'msg')
    expect(api.gitStage).not.toHaveBeenCalled()
  })

  test('commits everything when nothing is staged, and never pushes', async () => {
    const { git } = ops([file({ path: '/b' })])
    expect(await git.commit('msg')).toBe(true)
    expect(api.gitStage).toHaveBeenCalledWith('/p', ['/b'])
    expect(api.gitCommit).toHaveBeenCalledWith('/p', 'msg')
    expect(api.gitPush).not.toHaveBeenCalled()
  })

  test('never commits all over an unresolved conflict', async () => {
    const { git } = ops([file({ path: '/c', conflicted: true })])
    expect(await git.commit('msg')).toBe(false)
    expect(api.gitCommit).not.toHaveBeenCalled()
    expect(git.error.value?.conflicts).toBe(true)
  })

  test('an empty message commits nothing', async () => {
    const { git } = ops([file({ path: '/b' })])
    expect(await git.commit('  ')).toBe(false)
    expect(api.gitCommit).not.toHaveBeenCalled()
  })

  test('a failed pull reports its reason and re-reads status only', async () => {
    const { git, hooks } = ops([])
    expect(await git.pull()).toBe(false)
    expect(git.error.value).toEqual({ op: 'pull', failure: 'diverged', message: 'nope' })
    expect(gitRemoteErrorKey(git.error.value!)).toBe('git.error.diverged')
    expect(hooks.refresh).toHaveBeenCalled()
    expect(hooks.worktreeChanged).not.toHaveBeenCalled()
  })

  test('stage all takes conflicts and changes, not what is already staged', async () => {
    const { git } = ops([
      file({ path: '/s', index: 'A', worktree: null }),
      file({ path: '/c', conflicted: true }),
      file({ path: '/u', untracked: true, worktree: null })
    ])
    await git.stageAll()
    expect(api.gitStage).toHaveBeenCalledWith('/p', ['/c', '/u'])
  })
})

describe('followedDiffTabs', () => {
  const working = diffTabPath('working', '/p/a.kicad_sch')
  const staged = diffTabPath('staged', '/p/a.kicad_sch')

  test('a stage moves the Changes tab to Staged, an unstage moves it back', () => {
    expect(
      followedDiffTabs([working], [file({ path: '/p/a.kicad_sch', index: 'M', worktree: null })])
    ).toEqual([[working, staged]])
    expect(followedDiffTabs([staged], [file({ path: '/p/a.kicad_sch' })])).toEqual([
      [staged, working]
    ])
  })

  test('a change still on its side, gone everywhere, or already open there stays put', () => {
    const both = file({ path: '/p/a.kicad_sch', index: 'M', worktree: 'M' })
    expect(followedDiffTabs([working], [both])).toEqual([])
    expect(followedDiffTabs([working], [])).toEqual([])
    const stagedOnly = file({ path: '/p/a.kicad_sch', index: 'M', worktree: null })
    expect(followedDiffTabs([working, staged], [stagedOnly])).toEqual([])
  })

  test('a symbol tab keeps its symbol', () => {
    const tab = diffTabPath('working', '/p/lib.kicad_sym', 'R')
    const moved = followedDiffTabs(
      [tab],
      [file({ path: '/p/lib.kicad_sym', index: 'M', worktree: null })]
    )
    expect(moved).toEqual([[tab, diffTabPath('staged', '/p/lib.kicad_sym', 'R')]])
  })
})
