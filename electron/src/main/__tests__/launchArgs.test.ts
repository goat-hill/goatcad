import { describe, test, expect } from 'vitest'
import { groupOpenTargets, isKicadFile, parseFileArgs } from '../launchArgs'

const exists = (): boolean => true

describe('isKicadFile', () => {
  test('accepts every registered KiCad extension, case-insensitively', () => {
    expect(isKicadFile('/p/board.kicad_pcb')).toBe(true)
    expect(isKicadFile('/p/sheet.kicad_sch')).toBe(true)
    expect(isKicadFile('/p/proj.kicad_pro')).toBe(true)
    expect(isKicadFile('/p/part.kicad_mod')).toBe(true)
    expect(isKicadFile('/p/sym.kicad_sym')).toBe(true)
    expect(isKicadFile('/p/BOARD.KICAD_PCB')).toBe(true)
  })

  test('rejects everything else', () => {
    expect(isKicadFile('/p/readme.md')).toBe(false)
    expect(isKicadFile('/p/kicad_pcb')).toBe(false)
    expect(isKicadFile('/p/board.kicad_pcb.bak')).toBe(false)
  })
})

describe('parseFileArgs', () => {
  test('reads files after the executable when packaged', () => {
    expect(
      parseFileArgs(['/opt/GoatCAD/goatcad', '/p/board.kicad_pcb'], {
        isPackaged: true,
        cwd: '/cwd',
        exists
      })
    ).toEqual(['/p/board.kicad_pcb'])
  })

  test('skips the app path argument when unpackaged', () => {
    expect(
      parseFileArgs(['electron', '.', '/p/board.kicad_pcb'], {
        isPackaged: false,
        cwd: '/cwd',
        exists
      })
    ).toEqual(['/p/board.kicad_pcb'])
  })

  test('ignores switches, non-KiCad files, and the app path', () => {
    expect(
      parseFileArgs(['exe', '--enable-unsafe-webgpu', '.', '/p/readme.md', '/p/a.kicad_sch'], {
        isPackaged: true,
        cwd: '/cwd',
        exists
      })
    ).toEqual(['/p/a.kicad_sch'])
  })

  test('resolves relative paths against the working directory', () => {
    expect(
      parseFileArgs(['exe', 'board.kicad_pcb'], { isPackaged: true, cwd: '/work', exists })
    ).toEqual(['/work/board.kicad_pcb'])
  })

  test('drops files that do not exist', () => {
    expect(
      parseFileArgs(['exe', '/p/gone.kicad_pcb'], {
        isPackaged: true,
        cwd: '/cwd',
        exists: () => false
      })
    ).toEqual([])
  })

  test('de-duplicates repeated paths', () => {
    expect(
      parseFileArgs(['exe', '/p/a.kicad_sch', '/p/a.kicad_sch'], {
        isPackaged: true,
        cwd: '/cwd',
        exists
      })
    ).toEqual(['/p/a.kicad_sch'])
  })
})

describe('groupOpenTargets', () => {
  test('opens a file with its containing folder as the project', () => {
    expect(groupOpenTargets(['/proj/board.kicad_pcb'])).toEqual([
      {
        projectPath: '/proj',
        tabs: [{ name: 'board.kicad_pcb', path: '/proj/board.kicad_pcb' }]
      }
    ])
  })

  test('opens a .kicad_pro as a folder with no tab', () => {
    expect(groupOpenTargets(['/proj/thing.kicad_pro'])).toEqual([
      { projectPath: '/proj', tabs: [] }
    ])
  })

  test('groups files from the same folder into one window', () => {
    const targets = groupOpenTargets(['/proj/a.kicad_sch', '/proj/b.kicad_pcb'])
    expect(targets).toHaveLength(1)
    expect(targets[0].tabs.map((t) => t.name)).toEqual(['a.kicad_sch', 'b.kicad_pcb'])
  })

  test('splits files from different folders into separate windows', () => {
    const targets = groupOpenTargets(['/one/a.kicad_sch', '/two/b.kicad_sch'])
    expect(targets.map((t) => t.projectPath)).toEqual(['/one', '/two'])
  })

  test('a .kicad_pro alongside a sibling file contributes only its folder', () => {
    expect(groupOpenTargets(['/proj/thing.kicad_pro', '/proj/a.kicad_sch'])).toEqual([
      {
        projectPath: '/proj',
        tabs: [{ name: 'a.kicad_sch', path: '/proj/a.kicad_sch' }]
      }
    ])
  })
})
