import { describe, expect, test } from 'vitest'
import { collectBoards, isUnder, type FileNode } from '../projectMembers'

const dir = (name: string, path: string, children: FileNode[]): FileNode => ({
  name,
  path,
  isDirectory: true,
  children
})
const file = (name: string, path: string): FileNode => ({ name, path, isDirectory: false })

describe('isUnder', () => {
  test('accepts the directory itself and its descendants', () => {
    expect(isUnder('/hw/psu', '/hw/psu')).toBe(true)
    expect(isUnder('/hw/psu/sch/power.kicad_sch', '/hw/psu')).toBe(true)
  })

  test('rejects a sibling sharing a name prefix', () => {
    expect(isUnder('/hw/psu-old/a.kicad_pcb', '/hw/psu')).toBe(false)
  })

  test('ignores case and trailing separators', () => {
    expect(isUnder('/hw/PSU/a.kicad_pcb', '/hw/psu/')).toBe(true)
  })
})

describe('collectBoards', () => {
  // A workspace holding one project plus an unrelated sibling folder.
  const tree: FileNode[] = [
    dir('psu', '/hw/psu', [
      file('psu.kicad_pro', '/hw/psu/psu.kicad_pro'),
      file('psu.kicad_pcb', '/hw/psu/psu.kicad_pcb'),
      file('main.kicad_sch', '/hw/psu/main.kicad_sch'),
      dir('alt', '/hw/psu/alt', [file('psu-rev-b.kicad_pcb', '/hw/psu/alt/psu-rev-b.kicad_pcb')])
    ]),
    dir('mcu', '/hw/mcu', [file('mcu.kicad_pcb', '/hw/mcu/mcu.kicad_pcb')])
  ]

  const boards = collectBoards(tree, '/hw/psu')

  test('finds boards at any depth, sorted, ignoring other file types', () => {
    expect(boards.map((b) => b.name)).toEqual(['psu-rev-b.kicad_pcb', 'psu.kicad_pcb'])
  })

  test('excludes a sibling project in the same workspace', () => {
    expect(boards.some((b) => b.path.includes('/mcu/'))).toBe(false)
  })

  test('an empty workspace yields an empty list, not undefined', () => {
    expect(collectBoards([], '/hw/psu')).toEqual([])
  })
})
