import { describe, expect, test } from 'vitest'
import { parseUnifiedDiff, splitRows } from '../unifiedDiff'

const DIFF = [
  'diff --git a/board.kicad_sch b/board.kicad_sch',
  'index 1111111..2222222 100644',
  '--- a/board.kicad_sch',
  '+++ b/board.kicad_sch',
  '@@ -1,4 +1,5 @@ (kicad_sch',
  ' one',
  '-two',
  '+TWO',
  '+two and a half',
  ' three',
  ' four',
  '@@ -10 +11,0 @@',
  '-ten',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('parseUnifiedDiff', () => {
  test('numbers each side independently and counts changes', () => {
    const diff = parseUnifiedDiff(DIFF)
    expect(diff.binary).toBe(false)
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(2)
    expect(diff.hunks).toHaveLength(2)
    const [first, second] = diff.hunks
    expect(first.section).toBe('(kicad_sch')
    expect(first.lines).toEqual([
      { kind: 'context', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'two', oldNo: 2 },
      { kind: 'add', text: 'TWO', newNo: 2 },
      { kind: 'add', text: 'two and a half', newNo: 3 },
      { kind: 'context', text: 'three', oldNo: 3, newNo: 4 },
      { kind: 'context', text: 'four', oldNo: 4, newNo: 5 }
    ])
    // A count omitted from the header means one line.
    expect(second.oldLines).toBe(1)
    expect(second.newLines).toBe(0)
    expect(second.lines).toEqual([{ kind: 'del', text: 'ten', oldNo: 10 }])
  })

  test('reports a binary change with no hunks', () => {
    const diff = parseUnifiedDiff(
      'diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n'
    )
    expect(diff).toEqual({ binary: true, hunks: [], added: 0, removed: 0 })
  })

  test('an empty diff is empty, not an error', () => {
    expect(parseUnifiedDiff('')).toEqual({ binary: false, hunks: [], added: 0, removed: 0 })
  })

  test('tolerates CRLF output', () => {
    const diff = parseUnifiedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n')
    expect(diff.hunks[0].lines.map((l) => l.text)).toEqual(['a', 'b'])
  })
})

describe('splitRows', () => {
  test('pairs a rewritten block and runs the longer side against blanks', () => {
    const rows = splitRows(parseUnifiedDiff(DIFF).hunks[0])
    expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
      ['one', 'one'],
      ['two', 'TWO'],
      [undefined, 'two and a half'],
      ['three', 'three'],
      ['four', 'four']
    ])
  })

  test('a deletion after additions starts its own block', () => {
    const hunk = parseUnifiedDiff('@@ -1,2 +1,2 @@\n+a\n-b\n+c\n').hunks[0]
    expect(splitRows(hunk).map((r) => [r.left?.text, r.right?.text])).toEqual([
      [undefined, 'a'],
      ['b', 'c']
    ])
  })
})
