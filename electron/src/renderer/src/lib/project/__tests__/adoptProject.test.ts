import { describe, expect, it } from 'vitest'
import { scanForAdoption, type FolderEntry } from '../adoptProject'

const file = (name: string): FolderEntry => ({ name, isDirectory: false })
const dir = (name: string): FolderEntry => ({ name, isDirectory: true })

describe('scanForAdoption', () => {
  it('reports an empty folder as having nothing to adopt', () => {
    const scan = scanForAdoption([], 'blank')
    expect(scan.existingProject).toBeNull()
    expect(scan.schematics).toEqual([])
    expect(scan.boards).toEqual([])
    expect(scan.suggestedRootSheet).toBeNull()
    expect(scan.suggestedName).toBe('blank')
  })

  it('finds loose design files and defaults the name to the folder', () => {
    const scan = scanForAdoption([file('power.kicad_sch'), file('power.kicad_pcb')], 'psu-files')
    expect(scan.schematics.map((s) => s.name)).toEqual(['power.kicad_sch'])
    expect(scan.boards.map((b) => b.name)).toEqual(['power.kicad_pcb'])
    // The folder names the project even when the design files disagree — the
    // user retitles it if they want, and guessing from one of several is worse.
    expect(scan.suggestedName).toBe('psu-files')
    expect(scan.suggestedRootSheet).toBe('power.kicad_sch')
  })

  it('prefers the sheet named after the folder as the root', () => {
    const scan = scanForAdoption(
      [file('amp.kicad_sch'), file('psu.kicad_sch'), file('zzz.kicad_sch')],
      'psu'
    )
    expect(scan.suggestedRootSheet).toBe('psu.kicad_sch')
  })

  it('falls back to the first sheet when none is the folder namesake', () => {
    const scan = scanForAdoption([file('amp.kicad_sch'), file('driver.kicad_sch')], 'unrelated')
    expect(scan.suggestedRootSheet).toBe('amp.kicad_sch')
  })

  it('surfaces an existing project rather than treating it as adoptable', () => {
    const scan = scanForAdoption([file('psu.kicad_pro'), file('psu.kicad_sch')], 'psu')
    expect(scan.existingProject).toBe('psu.kicad_pro')
  })

  it('ignores directories and nested files', () => {
    const scan = scanForAdoption([dir('sub.kicad_sch'), file('top.kicad_sch')], 'p')
    expect(scan.schematics.map((s) => s.name)).toEqual(['top.kicad_sch'])
  })

  it('matches extensions case-insensitively', () => {
    const scan = scanForAdoption([file('Power.KiCad_Sch')], 'power')
    expect(scan.schematics.map((s) => s.stem)).toEqual(['Power'])
    expect(scan.suggestedRootSheet).toBe('Power.KiCad_Sch')
  })
})
