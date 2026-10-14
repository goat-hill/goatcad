import { describe, test, expect } from 'vitest'
import {
  MAX_STATUS_FILES,
  discardPlan,
  gitignoreWithPattern,
  parseBranchList,
  parsePorcelainV2
} from '../gitStatus'

const ROOT = '/repo'
const H = '0000000000000000000000000000000000000000'
const OID = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'

/** Join porcelain-v2 records with the `-z` NUL framing (trailing NUL included). */
const z = (...records: string[]): string => records.map((r) => `${r}\0`).join('')

const headers = (...extra: string[]): string[] => [
  `# branch.oid ${OID}`,
  '# branch.head main',
  ...extra
]

describe('parsePorcelainV2', () => {
  test('a nested repository is not a file, so it is not listed', () => {
    const files = parsePorcelainV2(z(...headers(), '? .history/', '? a.txt'), ROOT).files
    expect(files.map((f) => f.relPath)).toEqual(['a.txt'])
  })

  test('clean repo with upstream reports branch and ahead/behind', () => {
    const out = z(...headers('# branch.upstream origin/main', '# branch.ab +3 -1'))
    const parsed = parsePorcelainV2(out, ROOT)
    expect(parsed.branch).toBe('main')
    expect(parsed.detached).toBeUndefined()
    expect(parsed.ahead).toBe(3)
    expect(parsed.behind).toBe(1)
    expect(parsed.files).toEqual([])
    expect(parsed.truncated).toBeUndefined()
  })

  test('no upstream leaves ahead/behind undefined', () => {
    const parsed = parsePorcelainV2(z(...headers()), ROOT)
    expect(parsed.ahead).toBeUndefined()
    expect(parsed.behind).toBeUndefined()
  })

  test('ordinary changes: worktree-modified, staged+modified, staged-new, deletions', () => {
    const out = z(
      ...headers(),
      `1 .M N... 100644 100644 100644 ${H} ${H} a.kicad_sch`,
      `1 MM N... 100644 100644 100644 ${H} ${H} b.kicad_pcb`,
      `1 A. N... 000000 100644 100644 ${H} ${H} c.txt`,
      `1 .D N... 100644 100644 000000 ${H} ${H} d.txt`,
      `1 D. N... 100644 000000 000000 ${H} ${H} e.txt`
    )
    const parsed = parsePorcelainV2(out, ROOT)
    expect(parsed.files).toHaveLength(5)
    const byRel = Object.fromEntries(parsed.files.map((f) => [f.relPath, f]))
    expect(byRel['a.kicad_sch']).toMatchObject({
      index: null,
      worktree: 'M',
      path: '/repo/a.kicad_sch'
    })
    expect(byRel['b.kicad_pcb']).toMatchObject({ index: 'M', worktree: 'M' })
    expect(byRel['c.txt']).toMatchObject({ index: 'A', worktree: null })
    expect(byRel['d.txt']).toMatchObject({ index: null, worktree: 'D' })
    expect(byRel['e.txt']).toMatchObject({ index: 'D', worktree: null })
    for (const f of parsed.files) {
      expect(f.conflicted).toBe(false)
      expect(f.untracked).toBe(false)
    }
  })

  test('typechange (T) collapses to M', () => {
    const out = z(...headers(), `1 .T N... 100644 100644 120000 ${H} ${H} link.txt`)
    expect(parsePorcelainV2(out, ROOT).files[0].worktree).toBe('M')
  })

  test('paths with spaces survive -z framing', () => {
    const out = z(
      ...headers(),
      `1 .M N... 100644 100644 100644 ${H} ${H} sub dir/my board.kicad_pcb`,
      '? untracked file.txt'
    )
    const parsed = parsePorcelainV2(out, ROOT)
    expect(parsed.files.map((f) => f.relPath)).toEqual([
      'sub dir/my board.kicad_pcb',
      'untracked file.txt'
    ])
    expect(parsed.files[0].path).toBe('/repo/sub dir/my board.kicad_pcb')
  })

  test('rename consumes the following NUL token as the original path', () => {
    const out = z(
      ...headers(),
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.txt`,
      'old name.txt',
      '? later.txt'
    )
    const parsed = parsePorcelainV2(out, ROOT)
    expect(parsed.files).toHaveLength(2)
    const renamed = parsed.files.find((f) => f.relPath === 'new name.txt')
    expect(renamed).toMatchObject({ index: 'R', worktree: null, renamedFrom: '/repo/old name.txt' })
    // the origPath token must not be misread as its own entry
    expect(parsed.files.some((f) => f.relPath === 'old name.txt')).toBe(false)
    expect(parsed.files.some((f) => f.relPath === 'later.txt')).toBe(true)
  })

  test('unmerged entries are conflicted', () => {
    const out = z(
      ...headers(),
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} clash.kicad_sch`,
      `u AA N... 000000 100644 100644 100644 ${H} ${H} ${H} both added.txt`
    )
    const parsed = parsePorcelainV2(out, ROOT)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files.every((f) => f.conflicted)).toBe(true)
    expect(parsed.files.find((f) => f.relPath === 'clash.kicad_sch')).toMatchObject({
      index: 'U',
      worktree: 'U'
    })
  })

  test('untracked files', () => {
    const parsed = parsePorcelainV2(z(...headers(), '? notes.md'), ROOT)
    expect(parsed.files[0]).toMatchObject({
      relPath: 'notes.md',
      untracked: true,
      index: null,
      worktree: null
    })
  })

  test('detached HEAD shows the short oid as the branch label', () => {
    const out = z(`# branch.oid ${OID}`, '# branch.head (detached)')
    const parsed = parsePorcelainV2(out, ROOT)
    expect(parsed.detached).toBe(true)
    expect(parsed.branch).toBe(OID.slice(0, 7))
  })

  test('initial commit (no HEAD yet) still reports the branch name', () => {
    const out = z('# branch.oid (initial)', '# branch.head main', '? first.txt')
    const parsed = parsePorcelainV2(out, ROOT)
    expect(parsed.branch).toBe('main')
    expect(parsed.files).toHaveLength(1)
  })

  test('resolves paths against a repo root above the project folder', () => {
    const out = z(
      ...headers(),
      `1 .M N... 100644 100644 100644 ${H} ${H} boards/amp/main.kicad_pcb`
    )
    const parsed = parsePorcelainV2(out, '/home/user/hw')
    expect(parsed.files[0].path).toBe('/home/user/hw/boards/amp/main.kicad_pcb')
  })

  test('files sort by relPath', () => {
    const out = z(
      ...headers(),
      '? zebra.txt',
      `1 .M N... 100644 100644 100644 ${H} ${H} alpha.txt`,
      '? middle/file.txt'
    )
    expect(parsePorcelainV2(out, ROOT).files.map((f) => f.relPath)).toEqual([
      'alpha.txt',
      'middle/file.txt',
      'zebra.txt'
    ])
  })

  test('caps the list and flags truncation', () => {
    const records = Array.from(
      { length: MAX_STATUS_FILES + 5 },
      (_, i) => `? f${String(i).padStart(5, '0')}.txt`
    )
    const parsed = parsePorcelainV2(z(...headers(), ...records), ROOT)
    expect(parsed.files).toHaveLength(MAX_STATUS_FILES)
    expect(parsed.truncated).toBe(true)
  })

  test('empty output (clean repo, no headers) yields nothing', () => {
    const parsed = parsePorcelainV2('', ROOT)
    expect(parsed.files).toEqual([])
    expect(parsed.branch).toBeUndefined()
  })
})

describe('discardPlan', () => {
  test('routes tracked files to restore and untracked files to remove', () => {
    const plan = discardPlan([
      { path: '/p/tracked.txt', untracked: false },
      { path: '/p/new.txt', untracked: true },
      { path: '/p/also tracked.kicad_sch', untracked: false }
    ])
    expect(plan.restore).toEqual(['/p/tracked.txt', '/p/also tracked.kicad_sch'])
    expect(plan.remove).toEqual(['/p/new.txt'])
  })

  test('empty input yields empty sets', () => {
    expect(discardPlan([])).toEqual({ restore: [], remove: [] })
  })
})

describe('parseBranchList', () => {
  test('parses names in given order and flags the current branch', () => {
    const out = ' \0feature/picker\n*\0master\n \0fix-1\n'
    expect(parseBranchList(out)).toEqual([
      { name: 'feature/picker', current: false },
      { name: 'master', current: true },
      { name: 'fix-1', current: false }
    ])
  })

  test('drops the detached-HEAD pseudo-entry and blank lines', () => {
    const out = '*\0(HEAD detached at ab12cd3)\n \0master\n\n'
    expect(parseBranchList(out)).toEqual([{ name: 'master', current: false }])
  })

  test('empty output (no branches yet) yields an empty list', () => {
    expect(parseBranchList('')).toEqual([])
  })
})

describe('gitignoreWithPattern', () => {
  test('appends on its own line, adding the missing final newline first', () => {
    expect(gitignoreWithPattern('', '/.history/')).toBe('/.history/\n')
    expect(gitignoreWithPattern('*.bak', '/.history/')).toBe('*.bak\n/.history/\n')
    expect(gitignoreWithPattern('*.bak\n', '/out.pdf')).toBe('*.bak\n/out.pdf\n')
  })

  test('keeps CRLF files CRLF, and leaves a file that already has it alone', () => {
    expect(gitignoreWithPattern('*.bak\r\n', '/x')).toBe('*.bak\r\n/x\r\n')
    expect(gitignoreWithPattern('/x\n*.bak\n', '/x')).toBeNull()
  })
})
