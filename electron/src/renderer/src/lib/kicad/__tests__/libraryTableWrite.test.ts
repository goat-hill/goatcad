import { describe, expect, test } from 'vitest'
import {
  addLibraryToTable,
  projectLibUri,
  tableNicknameFor,
  tableNicknames,
  uniqueNickname
} from '../libraryTableWrite'
import { parseSymLibTable } from '../symbolLibraryTable'

describe('projectLibUri', () => {
  test('writes a library inside the project as ${KIPRJMOD}-relative', () => {
    expect(projectLibUri('/home/u/proj/lib/parts.kicad_sym', '/home/u/proj')).toBe(
      '${KIPRJMOD}/lib/parts.kicad_sym'
    )
  })

  test('leaves a library outside the project absolute', () => {
    expect(projectLibUri('/opt/kicad/symbols/Device.kicad_sym', '/home/u/proj')).toBe(
      '/opt/kicad/symbols/Device.kicad_sym'
    )
  })

  test('treats a case-differing prefix as inside, matching macOS/Windows filesystems', () => {
    expect(projectLibUri('/Home/U/Proj/lib/p.kicad_sym', '/home/u/proj')).toBe(
      '${KIPRJMOD}/lib/p.kicad_sym'
    )
  })

  test('handles Windows separators', () => {
    expect(projectLibUri('C:\\work\\proj\\lib\\p.kicad_sym', 'C:\\work\\proj')).toBe(
      '${KIPRJMOD}/lib/p.kicad_sym'
    )
  })

  test('does not mistake a sibling folder with a shared prefix for the project', () => {
    expect(projectLibUri('/home/u/proj-other/p.kicad_sym', '/home/u/proj')).toBe(
      '/home/u/proj-other/p.kicad_sym'
    )
  })
})

describe('addLibraryToTable', () => {
  test('creates the document when the project has no table yet', () => {
    const out = addLibraryToTable(null, 'symbol', 'parts', '${KIPRJMOD}/parts.kicad_sym')
    expect(out).toBe(`(sym_lib_table
  (version 7)
  (lib (name "parts")(type "KiCad")(uri "\${KIPRJMOD}/parts.kicad_sym")(options "")(descr ""))
)
`)
  })

  test('the created document parses back through the reader', () => {
    const out = addLibraryToTable(null, 'symbol', 'parts', '${KIPRJMOD}/parts.kicad_sym')
    expect(parseSymLibTable(out, '/home/u/proj')).toEqual([
      { nickname: 'parts', path: '/home/u/proj/parts.kicad_sym', scope: 'project' }
    ])
  })

  test('appends to an existing table without disturbing what is there', () => {
    const existing = `(sym_lib_table
  (version 7)
  (lib (name "existing")(type "KiCad")(uri "\${KIPRJMOD}/a.kicad_sym")(options "")(descr "keep me"))
)
`
    const out = addLibraryToTable(existing, 'symbol', 'added', '${KIPRJMOD}/b.kicad_sym')
    // The prior row must survive byte-identically — a project we touch should
    // diff by the added row only (RULES.md §7).
    expect(out).toContain('(lib (name "existing")(type "KiCad")(uri "${KIPRJMOD}/a.kicad_sym")')
    expect(out).toContain('(descr "keep me")')
    expect(parseSymLibTable(out, '/p').map((l) => l.nickname)).toEqual(['existing', 'added'])
  })

  test('writes an fp_lib_table for footprint scope', () => {
    expect(addLibraryToTable(null, 'footprint', 'proj', '${KIPRJMOD}/proj.pretty')).toContain(
      '(fp_lib_table'
    )
  })

  test('escapes quotes and backslashes in names and paths', () => {
    const out = addLibraryToTable(null, 'symbol', 'od"d', 'C:\\libs\\x.kicad_sym')
    expect(out).toContain('(name "od\\"d")')
    expect(out).toContain('(uri "C:\\\\libs\\\\x.kicad_sym")')
    expect(parseSymLibTable(out, null)[0].nickname).toBe('od"d')
  })
})

describe('nicknames', () => {
  test('reads the nicknames already registered', () => {
    const table = `(sym_lib_table
  (lib (name "one")(type "KiCad")(uri "a")(options "")(descr ""))
  (lib (name "two")(type "KiCad")(uri "b")(options "")(descr ""))
)`
    expect(tableNicknames(table)).toEqual(['one', 'two'])
  })

  test('suffixes a colliding nickname rather than shadowing the existing library', () => {
    expect(uniqueNickname('Device', ['Device', 'device-1'])).toBe('Device-2')
    expect(uniqueNickname('Fresh', ['Device'])).toBe('Fresh')
  })
})

describe('tableNicknameFor', () => {
  const table = `(fp_lib_table
  (version 7)
  (lib (name "Other")(type "KiCad")(uri "/opt/libs/Other.pretty")(options "")(descr ""))
  (lib (name "board")(type "KiCad")(uri "\${KIPRJMOD}/board.pretty")(options "")(descr ""))
)
`
  test('finds the row a project-relative uri resolves to', () => {
    expect(tableNicknameFor(table, '/home/u/proj/board.pretty', '/home/u/proj')).toBe('board')
    expect(tableNicknameFor(table, '/opt/libs/other.pretty', '/home/u/proj')).toBe('Other')
  })

  test('answers null for a library no row names', () => {
    expect(tableNicknameFor(table, '/home/u/proj/new.pretty', '/home/u/proj')).toBeNull()
    expect(tableNicknameFor(null, '/home/u/proj/board.pretty', '/home/u/proj')).toBeNull()
  })
})
