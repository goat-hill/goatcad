import { describe, expect, test } from 'vitest'
import {
  blankFileContent,
  kindForFileName,
  newProjectFiles,
  stemOf,
  uniqueFileName
} from '../scaffold'
import { parseSExpr, findChild } from '../../kicad/sexpr'

describe('kindForFileName', () => {
  test('maps design extensions, case-insensitively', () => {
    expect(kindForFileName('main.kicad_sch')).toBe('schematic')
    expect(kindForFileName('Board.KICAD_PCB')).toBe('board')
    expect(kindForFileName('parts.kicad_sym')).toBe('symbol-library')
    expect(kindForFileName('LED.kicad_mod')).toBe('footprint')
  })

  test('returns null for everything else, which becomes an empty file', () => {
    expect(kindForFileName('notes.md')).toBeNull()
    expect(kindForFileName('kicad_sch')).toBeNull()
  })
})

describe('blankFileContent', () => {
  test('a footprint carries the file’s own stem as its name', () => {
    expect(blankFileContent('footprint', 'LED_0805.kicad_mod')).toContain('(footprint "LED_0805"')
  })

  test('every schematic gets a distinct uuid', () => {
    const uuidOf = (text: string): string | undefined =>
      /\(uuid "([^"]+)"\)/.exec(text)?.[1] ?? undefined
    const first = uuidOf(blankFileContent('schematic', 'a.kicad_sch'))
    const second = uuidOf(blankFileContent('schematic', 'b.kicad_sch'))
    expect(first).toBeDefined()
    expect(first).not.toBe(second)
  })
})

describe('stemOf', () => {
  test('drops the final extension only', () => {
    expect(stemOf('LED_0805.kicad_mod')).toBe('LED_0805')
    expect(stemOf('my.part.kicad_mod')).toBe('my.part')
    expect(stemOf('README')).toBe('README')
  })
})

describe('uniqueFileName', () => {
  test('uses the plain name when it is free', () => {
    expect(uniqueFileName('board', '.kicad_pcb', ['main.kicad_sch'])).toBe('board.kicad_pcb')
  })

  test('suffixes past every taken name, case-insensitively', () => {
    const siblings = ['board.kicad_pcb', 'Board-1.kicad_pcb']
    expect(uniqueFileName('board', '.kicad_pcb', siblings)).toBe('board-2.kicad_pcb')
  })
})

describe('newProjectFiles', () => {
  test('names all three files after the project folder', () => {
    expect(newProjectFiles('blinky').map((f) => f.name)).toEqual([
      'blinky.kicad_pro',
      'blinky.kicad_sch',
      'blinky.kicad_pcb'
    ])
  })

  test('the project file and the root schematic agree on the root sheet uuid', () => {
    // KiCad resolves the root sheet through this uuid; a mismatch is a project
    // that opens with no root, which is why one uuid is shared, not two made.
    const files = newProjectFiles('blinky')
    const project = JSON.parse(files[0].content)
    const schematic = parseSExpr(files[1].content)
    if (schematic.type !== 'list') throw new Error('schematic root is not a list')
    const uuidAtom = findChild(schematic, 'uuid')?.children[1]
    const schematicUuid = uuidAtom?.type === 'atom' ? uuidAtom.value : null

    expect(schematicUuid).toBeTruthy()
    expect(project.sheets).toEqual([[schematicUuid, 'Root']])
  })
})
