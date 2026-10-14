import { describe, expect, it } from 'vitest'
import { parseSymLibTable, resolveLibUri } from '../symbolLibraryTable'

const TABLE = `(sym_lib_table
  (version 7)
  (lib (name "Device")(type "KiCad")(uri "\${KICAD_SYMBOL_DIR}/Device.kicad_sym")(options "")(descr ""))
  (lib (name "myparts")(type "KiCad")(uri "\${KIPRJMOD}/myparts.kicad_sym")(options "")(descr "Project parts"))
)
`

describe('parseSymLibTable', () => {
  it('extracts nickname + resolved path for each lib', () => {
    const libs = parseSymLibTable(TABLE, '/home/me/proj')
    expect(libs.map((l) => l.nickname)).toEqual(['Device', 'myparts'])
    expect(libs[1].path).toBe('/home/me/proj/myparts.kicad_sym')
    expect(libs[1].scope).toBe('project')
  })

  it('leaves unresolvable URI variables intact', () => {
    const libs = parseSymLibTable(TABLE, '/home/me/proj')
    expect(libs[0].path).toBe('${KICAD_SYMBOL_DIR}/Device.kicad_sym')
  })

  it('rejects non-table documents', () => {
    expect(() => parseSymLibTable('(fp_lib_table (version 7))', null)).toThrow(/sym_lib_table/)
  })
})

describe('resolveLibUri', () => {
  it('expands KIPRJMOD to the project directory', () => {
    expect(resolveLibUri('${KIPRJMOD}/a.kicad_sym', '/p')).toBe('/p/a.kicad_sym')
    expect(resolveLibUri('$(KIPRJMOD)/a.kicad_sym', '/p')).toBe('/p/a.kicad_sym')
  })

  it('is a no-op when there is no project directory', () => {
    expect(resolveLibUri('${KIPRJMOD}/a.kicad_sym', null)).toBe('${KIPRJMOD}/a.kicad_sym')
  })
})
