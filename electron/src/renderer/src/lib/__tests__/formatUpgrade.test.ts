import { describe, expect, test } from 'vitest'
import { createFormatUpgrader, sniffFormat } from '../formatUpgrade'
import type { HierarchyFs } from '../schematic/hierarchy'

const memoryFs = (files: Record<string, string>): HierarchyFs => ({
  readFile: async (path) => files[path] ?? null,
  listSchematics: async (dir) =>
    Object.keys(files).filter((path) => path.startsWith(`${dir}/`) && path.endsWith('.kicad_sch'))
})

const ROOT = 'aaaaaaaa-0000-0000-0000-000000000001'
const SHEET = 'bbbbbbbb-0000-0000-0000-000000000002'
const SYMBOL = 'cccccccc-0000-0000-0000-000000000003'

describe('sniffFormat', () => {
  test('reads a file’s format, version and release from its head', () => {
    expect(sniffFormat('(kicad_sch (version 20231120) (generator "eeschema")')).toEqual({
      format: 'kicad_sch',
      version: 20231120,
      status: 'older',
      release: 8
    })
    expect(sniffFormat('(kicad_pcb\n\t(version 20260629)')?.status).toBe('newer')
    expect(sniffFormat('(footprint "R" (version 20210126)')?.status).toBe('unsupported')
    expect(sniffFormat('(fp_lib_table (version 7))')).toBeNull()
  })
})

describe('formatUpgrader', () => {
  test('a current file reads as it is', async () => {
    const upgrader = createFormatUpgrader(memoryFs({}))
    const text = '(kicad_pcb (version 20260206) (generator "pcbnew"))\n'
    expect(await upgrader.upgrade('/p/a.kicad_pcb', text)).toBe(text)
    expect(upgrader.isPendingUpgrade('/p/a.kicad_pcb')).toBe(false)
    expect(upgrader.isReadOnly('/p/a.kicad_pcb')).toBe(false)
  })

  test('an older file reads migrated and waits for its save', async () => {
    const upgrader = createFormatUpgrader(memoryFs({}))
    const text = await upgrader.upgrade(
      '/p/a.kicad_pcb',
      '(kicad_pcb (version 20240108) (generator "pcbnew"))'
    )
    expect(text).toContain('(version 20260206)')
    expect(upgrader.stateOf('/p/a.kicad_pcb')).toMatchObject({ version: 20240108, release: 8 })
    expect(upgrader.isPendingUpgrade('/p/a.kicad_pcb')).toBe(true)
    upgrader.noteSaved('/p/a.kicad_pcb')
    expect(upgrader.isPendingUpgrade('/p/a.kicad_pcb')).toBe(false)
  })

  test('a later sheet of a hierarchy too new to be legacy reads no other file', async () => {
    const sheet = (n: string): string =>
      `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${n}"))`
    const fs = memoryFs({ '/p/a.kicad_sch': sheet(ROOT), '/p/b.kicad_sch': sheet(SHEET) })
    let reads = 0
    const counting: HierarchyFs = { ...fs, readFile: (path) => (reads++, fs.readFile(path)) }
    const upgrader = createFormatUpgrader(counting)
    await upgrader.upgrade('/p/a.kicad_sch', sheet(ROOT))
    const first = reads
    expect(await upgrader.upgrade('/p/b.kicad_sch', sheet(SHEET))).toContain('(version 20260306)')
    expect(reads).toBe(first)
  })

  test('a newer file reads untouched and read-only', async () => {
    const upgrader = createFormatUpgrader(memoryFs({}))
    const text = '(kicad_sch (version 20260629) (generator "eeschema"))'
    expect(await upgrader.upgrade('/p/a.kicad_sch', text)).toBe(text)
    expect(upgrader.isReadOnly('/p/a.kicad_sch')).toBe(true)
  })

  test('a KiCad 6 hierarchy migrates together, whichever sheet is read first', async () => {
    const files = {
      '/p/demo.kicad_sch': `(kicad_sch (version 20211123) (uuid "${ROOT}")
        (sheet (at 0 0) (size 10 10) (uuid "${SHEET}")
          (property "Sheet name" "Power" (id 0) (at 0 0 0))
          (property "Sheet file" "power.kicad_sch" (id 1) (at 0 0 0)))
        (sheet_instances (path "/" (page "1")) (path "/${SHEET}" (page "2")))
        (symbol_instances (path "/${SHEET}/${SYMBOL}" (reference "R1") (unit 1) (value "10k") (footprint ""))))`,
      '/p/power.kicad_sch': `(kicad_sch (version 20211123) (uuid "dddddddd-0000-0000-0000-000000000004")
        (symbol (lib_id "Device:R") (at 0 0 0) (unit 1) (uuid "${SYMBOL}")
          (property "Reference" "R?" (id 0) (at 0 0 0))
          (property "Value" "R" (id 1) (at 0 0 0))))`
    }
    const upgrader = createFormatUpgrader(memoryFs(files))
    const sheet = await upgrader.upgrade('/p/power.kicad_sch', files['/p/power.kicad_sch'])
    expect(sheet).toContain(`(path "/${ROOT}/${SHEET}"`)
    expect(sheet).toMatch(/\(property "Reference" "R1"/)
    expect(sheet).toContain('(version 20260306)')

    const group = upgrader.saveGroupOf('/p/power.kicad_sch')
    expect(group?.files).toEqual(['/p/demo.kicad_sch', '/p/power.kicad_sch'])
    expect(group?.projectFile).toBe('/p/demo.kicad_pro')
    expect(group?.project).toEqual({
      rootFile: 'demo.kicad_sch',
      rootUuid: ROOT,
      rootName: 'demo',
      sheets: [[SHEET, 'Power']]
    })
    // The root, never opened, is ready to write with it.
    expect(upgrader.migratedText('/p/demo.kicad_sch')).not.toContain('symbol_instances')
  })
})
