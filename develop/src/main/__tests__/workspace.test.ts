import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { countWorkspace, listWorkspace } from '../workspace'

const tempDirs: string[] = []

const makeWorktree = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'goatherd-workspace-'))
  tempDirs.push(path)
  return path
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true })
})

describe('workspace listings', () => {
  it('classifies visible artifacts and orders them newest first', () => {
    const worktree = makeWorktree()
    const workspace = join(worktree, '.goatherd')
    mkdirSync(join(workspace, 'demo'), { recursive: true })
    writeFileSync(join(workspace, 'notes.md'), '# Notes')
    writeFileSync(join(workspace, 'demo', 'walkthrough.webm'), 'video')
    writeFileSync(join(workspace, '.meta.json'), '{"name":"ignored"}')
    utimesSync(join(workspace, 'notes.md'), 1, 1)
    utimesSync(join(workspace, 'demo', 'walkthrough.webm'), 2, 2)

    expect(listWorkspace(worktree)).toMatchObject([
      { relPath: 'demo/walkthrough.webm', kind: 'video' },
      { relPath: 'notes.md', kind: 'markdown' }
    ])
    expect(countWorkspace(worktree)).toBe(2)
  })

  it('treats a missing workspace as empty', () => {
    const worktree = makeWorktree()

    expect(listWorkspace(worktree)).toEqual([])
    expect(countWorkspace(worktree)).toBe(0)
  })
})
