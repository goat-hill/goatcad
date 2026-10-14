import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gitDiffOverview,
  listGitFiles,
  parseCommitLog,
  parseNameStatus,
  parseNumstat,
  parseStatusPorcelain,
  readGitPatch
} from '../gitDiff'

const REC = '\x1e'
const FIELD = '\x1f'

describe('parseNumstat', () => {
  it('reads counts, renames, and binary markers out of the -z stream', () => {
    const out = '1\t0\t\0one.txt\0renamed.txt\0' + '4\t2\tsrc/app.ts\0' + '-\t-\ticon.png\0'

    expect(parseNumstat(out)).toEqual([
      { path: 'renamed.txt', oldPath: 'one.txt', adds: 1, dels: 0, binary: false },
      { path: 'src/app.ts', oldPath: undefined, adds: 4, dels: 2, binary: false },
      { path: 'icon.png', oldPath: undefined, adds: 0, dels: 0, binary: true }
    ])
  })

  it('keeps a tab inside a path, which -z writes verbatim', () => {
    expect(parseNumstat('1\t0\todd\tname.txt\0')[0].path).toBe('odd\tname.txt')
  })
})

describe('parseNameStatus', () => {
  it('consumes the extra path a rename or copy record carries', () => {
    const out = 'R075\0one.txt\0renamed.txt\0' + 'A\0spaced name.txt\0' + 'D\0two.txt\0'

    expect(parseNameStatus(out)).toEqual([
      { status: 'renamed', oldPath: 'one.txt', path: 'renamed.txt' },
      { status: 'added', path: 'spaced name.txt' },
      { status: 'deleted', path: 'two.txt' }
    ])
  })
})

describe('parseStatusPorcelain', () => {
  it('picks out untracked entries without losing alignment on a rename', () => {
    const out = 'R  new.txt\0old.txt\0' + '?? fresh.txt\0' + ' M edited.txt\0'

    expect(parseStatusPorcelain(out)).toEqual({
      entries: ['new.txt', 'fresh.txt', 'edited.txt'],
      untracked: ['fresh.txt']
    })
  })
})

describe('parseCommitLog', () => {
  const record = (sha: string, parents: string, subject: string, body = ''): string =>
    [
      REC,
      sha,
      FIELD,
      sha.slice(0, 7),
      FIELD,
      parents,
      FIELD,
      'Someone',
      FIELD,
      '2026-08-01T10:00:00+00:00',
      FIELD,
      subject,
      FIELD,
      body ? `${subject}\n\n${body}\n` : `${subject}\n`,
      FIELD
    ].join('')

  it('sums each commit’s numstat block and splits its parents', () => {
    const out = [
      record('aaaaaaaaaa', 'bbbbbbbbbb cccccccccc', 'Merge branch'),
      '',
      record('bbbbbbbbbb', 'dddddddddd', 'Real work'),
      '3\t1\tsrc/a.ts',
      '-\t-\tlogo.png',
      ''
    ].join('\n')

    expect(parseCommitLog(out)).toMatchObject([
      {
        sha: 'aaaaaaaaaa',
        shortSha: 'aaaaaaa',
        parents: ['bbbbbbbbbb', 'cccccccccc'],
        author: 'Someone',
        subject: 'Merge branch',
        adds: 0,
        dels: 0,
        files: 0
      },
      {
        sha: 'bbbbbbbbbb',
        parents: ['dddddddddd'],
        subject: 'Real work',
        adds: 3,
        dels: 1,
        files: 2
      }
    ])
  })

  // The message is multi-line, so a line-oriented parse would read its body as
  // numstat: lose the message, and miscount anything in it that looks like one.
  it('keeps a multi-line message whole, and out of the numstat scan', () => {
    const body = 'Why it happened.\n\n1\t2\tnot-a-numstat-line\n\nCo-Authored-By: Someone'
    const out = `${record('aaaaaaaaaa', 'bbbbbbbbbb', 'The subject', body)}\n4\t2\tsrc/a.ts\n`

    const [commit] = parseCommitLog(out)

    expect(commit.subject).toBe('The subject')
    expect(commit.message).toBe(`The subject\n\n${body}`)
    expect({ adds: commit.adds, dels: commit.dels, files: commit.files }).toEqual({
      adds: 4,
      dels: 2,
      files: 1
    })
  })
})

// ---- against a real repository, where git's own output is the fixture ----

const repos: string[] = []

afterEach(() => {
  for (const path of repos.splice(0)) rmSync(path, { force: true, recursive: true })
})

const run = (repo: string, ...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}

const commit = (repo: string, message: string): void => {
  run(repo, 'add', '-A')
  run(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', 'commit', '-m', message)
}

/** master with one commit, then a `feat` branch that renames, edits, deletes, and adds. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'goatherd-gitdiff-'))
  repos.push(repo)
  run(repo, 'init', '-q', '-b', 'master')
  writeFileSync(join(repo, 'one.txt'), 'a\nb\nc\n')
  writeFileSync(join(repo, 'two.txt'), 'x\n')
  commit(repo, 'root')
  run(repo, 'checkout', '-q', '-b', 'feat')
  renameSync(join(repo, 'one.txt'), join(repo, 'renamed.txt'))
  writeFileSync(join(repo, 'renamed.txt'), 'a\nb\nc\nd\n')
  unlinkSync(join(repo, 'two.txt'))
  commit(repo, MESSAGE)
  return repo
}

/** Multi-line on purpose: the log format has to survive a real body, not just a subject. */
const MESSAGE = 'rename, extend, delete\n\nA body line.\n\nCo-Authored-By: Someone <x@example.com>'

describe('git diff reads', () => {
  it('summarizes the branch over its base', async () => {
    const repo = makeRepo()

    const overview = await gitDiffOverview(repo, 'master')

    expect(overview.error).toBeUndefined()
    expect(overview.mergeBase).toHaveLength(40)
    expect(overview.commits).toHaveLength(1)
    expect(overview.commits[0]).toMatchObject({
      subject: 'rename, extend, delete',
      // Straight from `git log`, so this covers the --format string itself.
      message: MESSAGE,
      files: 2
    })
    expect(overview.workingCount).toBe(0)
    expect(overview.branches).toEqual(expect.arrayContaining(['feat', 'master']))
  })

  it('names a base that does not exist rather than throwing', async () => {
    const overview = await gitDiffOverview(makeRepo(), 'nope')

    expect(overview.error).toContain('nope')
    expect(overview.commits).toEqual([])
  })

  it('reports the branch scope as a rename plus a delete', async () => {
    const repo = makeRepo()

    const { files } = await listGitFiles({
      worktree: repo,
      base: 'master',
      scope: { kind: 'branch' }
    })

    expect(files).toEqual([
      {
        path: 'renamed.txt',
        oldPath: 'one.txt',
        status: 'renamed',
        adds: 1,
        dels: 0,
        binary: false
      },
      { path: 'two.txt', oldPath: undefined, status: 'deleted', adds: 0, dels: 1, binary: false }
    ])
  })

  it('keeps a rename paired in the patch by passing both of its paths', async () => {
    const repo = makeRepo()

    const { patch } = await readGitPatch({
      worktree: repo,
      base: 'master',
      scope: { kind: 'branch' },
      path: 'renamed.txt',
      oldPath: 'one.txt',
      context: 3
    })

    expect(patch).toContain('rename from one.txt')
    expect(patch).toContain('+d')
  })

  it('diffs a commit against its first parent, and a root commit against nothing', async () => {
    const repo = makeRepo()
    const [head, root] = execFileSync('git', ['-C', repo, 'log', '--format=%H'], {
      encoding: 'utf8'
    })
      .trim()
      .split('\n')

    const headFiles = await listGitFiles({
      worktree: repo,
      base: 'master',
      scope: { kind: 'commit', sha: head }
    })
    const rootFiles = await listGitFiles({
      worktree: repo,
      base: 'master',
      scope: { kind: 'commit', sha: root }
    })

    expect(headFiles.files.map((file) => file.path)).toEqual(['renamed.txt', 'two.txt'])
    expect(rootFiles.files.map((file) => file.status)).toEqual(['added', 'added'])
  })

  it('lists untracked files in the working scope and diffs them against nothing', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'fresh.txt'), 'untracked\nlines\n')
    writeFileSync(join(repo, 'renamed.txt'), 'a\nb\nc\nd\ne\n')

    const { files, untrackedTruncated } = await listGitFiles({
      worktree: repo,
      base: 'master',
      scope: { kind: 'working' }
    })
    const { patch } = await readGitPatch({
      worktree: repo,
      base: 'master',
      scope: { kind: 'working' },
      path: 'fresh.txt',
      untracked: true,
      context: 3
    })

    expect(untrackedTruncated).toBe(0)
    expect(files).toMatchObject([
      { path: 'fresh.txt', status: 'untracked', adds: 2 },
      { path: 'renamed.txt', status: 'modified', adds: 1, dels: 0 }
    ])
    expect(patch).toContain('+untracked')
  })
})
