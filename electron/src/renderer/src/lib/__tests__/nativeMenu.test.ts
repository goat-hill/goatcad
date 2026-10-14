import { describe, expect, test } from 'vitest'
import { toNativeTemplate } from '../nativeMenu'
import type { MenuNode } from '../menu'

const fileItems: MenuNode[] = [
  {
    id: 'new',
    label: 'New',
    children: [
      { id: 'new:schematic', label: 'Schematic', shortcut: '⌘N' },
      { id: 'new:board', label: 'Board', disabled: true }
    ]
  },
  { divider: true },
  { id: 'save', label: 'Save', shortcut: '⌘S' },
  { divider: true },
  { id: 'exit', label: 'Exit', shortcut: 'Alt+F4' }
]

const template = (items: MenuNode[] = fileItems): ReturnType<typeof toNativeTemplate> =>
  toNativeTemplate([{ id: 'file', label: 'File', items }])

/** Flat probe over both node kinds, so a test can ask about any field. */
interface Probe {
  id?: string
  label?: string
  accelerator?: string
  enabled?: boolean
  submenu?: Probe[]
  divider?: true
}

const fileNodes = (items?: MenuNode[]): Probe[] => template(items).sections[0].items as Probe[]

describe('toNativeTemplate', () => {
  test('carries ids and labels across so both surfaces dispatch the same commands', () => {
    expect(template().sections[0].label).toBe('File')
    expect(fileNodes()[0]).toMatchObject({ id: 'new', label: 'New' })
  })

  test('translates shortcuts to accelerators rather than display text', () => {
    const save = fileNodes().find((node) => node.id === 'save')
    expect(save?.accelerator).toBe('CmdOrCtrl+S')
    const nested = fileNodes()[0].submenu ?? []
    expect(nested[0].accelerator).toBe('CmdOrCtrl+N')
  })

  test("Update PCB from Schematic carries KiCad's F8", () => {
    const tools = toNativeTemplate([
      { id: 'tools', label: 'Tools', items: [{ id: 'update-pcb', label: 'Update PCB' }] }
    ]).sections[0].items as Probe[]
    expect(tools[0].accelerator).toBe('F8')
  })

  test('leaves commands without a registered hotkey unaccelerated', () => {
    const nested = fileNodes()[0].submenu ?? []
    expect(nested[1].accelerator).toBeUndefined()
  })

  test('maps disabled to enabled:false, which is what Electron reads', () => {
    const nested = fileNodes()[0].submenu ?? []
    expect(nested[1].enabled).toBe(false)
    expect(nested[0].enabled).toBeUndefined()
  })

  test('drops Exit — macOS quits from the application menu', () => {
    expect(fileNodes().some((node) => node.id === 'exit')).toBe(false)
  })

  test('drops the divider the removed item left stranded at the end', () => {
    expect(fileNodes().at(-1)).toMatchObject({ id: 'save' })
  })

  test('collapses dividers that removals pushed together', () => {
    const nodes = fileNodes([
      { id: 'save', label: 'Save' },
      { divider: true },
      { id: 'exit', label: 'Exit' },
      { divider: true },
      { id: 'about', label: 'About' }
    ])
    expect(nodes.map((node) => node.id ?? 'divider')).toEqual(['save', 'divider', 'about'])
  })

  test('drops a leading divider', () => {
    const nodes = fileNodes([{ divider: true }, { id: 'save', label: 'Save' }])
    expect(nodes).toHaveLength(1)
  })

  test('flattens segmented labels to plain text', () => {
    const nodes = fileNodes([
      { id: 'new:symbol-library', label: [{ text: 'New ' }, { text: '.kicad_sym', code: true }] }
    ])
    expect(nodes[0].label).toBe('New .kicad_sym')
  })
})
