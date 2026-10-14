import { describe, expect, test, vi } from 'vitest'

// appMenu imports BrowserWindow/Menu at module scope for the stateful half;
// the template builder under test is pure data and needs neither.
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(), getFocusedWindow: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() }
}))

import { macMenuTemplate } from '../appMenu'
import type { NativeMenuTemplate } from '../../preload/menuTypes'

const template: NativeMenuTemplate = {
  sections: [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'new', label: 'New', submenu: [{ id: 'new:board', label: 'Board', enabled: false }] },
        { divider: true },
        { id: 'save', label: 'Save', accelerator: 'CmdOrCtrl+S' }
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [{ id: 'undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z' }]
    },
    { id: 'view', label: 'View', items: [{ id: 'dev-tools', label: 'Toggle Developer Tools' }] },
    { id: 'help', label: 'Help', items: [{ id: 'about', label: 'About GoatCAD' }] }
  ]
}

const labels = (nodes: { label?: string; role?: string }[]): string[] =>
  nodes.map((node) => node.label ?? `role:${node.role}`)

describe('macMenuTemplate', () => {
  test('interleaves the app and window roles in macOS bar order', () => {
    expect(labels(macMenuTemplate(template, () => {}))).toEqual([
      'role:appMenu',
      'File',
      'Edit',
      'View',
      'role:windowMenu',
      'Help'
    ])
  })

  test('marks the help section so macOS adds its search field', () => {
    const help = macMenuTemplate(template, () => {}).at(-1)
    expect(help?.role).toBe('help')
  })

  test('appends sections it does not know about after view', () => {
    const extended: NativeMenuTemplate = {
      sections: [...template.sections, { id: 'tools', label: 'Tools', items: [] }]
    }
    expect(labels(macMenuTemplate(extended, () => {}))).toEqual([
      'role:appMenu',
      'File',
      'Edit',
      'View',
      'Tools',
      'role:windowMenu',
      'Help'
    ])
  })

  test('gives Edit the clipboard roles, but never an Undo/Redo role', () => {
    const edit = macMenuTemplate(template, () => {})[2]
    const items = edit.submenu as { label?: string; role?: string; type?: string }[]
    expect(items.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'Undo',
      'separator',
      'cut',
      'copy',
      'paste',
      'selectAll'
    ])
  })

  test('carries accelerators, dividers and disabled state through', () => {
    const file = macMenuTemplate(template, () => {})[1]
    const items = file.submenu as { label?: string; type?: string; accelerator?: string }[]
    expect(items[1].type).toBe('separator')
    expect(items[2].accelerator).toBe('CmdOrCtrl+S')
    const nested = items[0] as unknown as { submenu: { enabled?: boolean }[] }
    expect(nested.submenu[0].enabled).toBe(false)
  })

  test('dispatches the command id of the clicked leaf, not its parent', () => {
    const dispatch = vi.fn()
    const file = macMenuTemplate(template, dispatch)[1]
    const items = file.submenu as { click?: () => void; submenu?: { click?: () => void }[] }[]
    expect(items[0].click).toBeUndefined()
    items[0].submenu?.[0].click?.()
    items[2].click?.()
    expect(dispatch.mock.calls).toEqual([['new:board'], ['save']])
  })
})
