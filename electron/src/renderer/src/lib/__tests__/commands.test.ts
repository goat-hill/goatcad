import { describe, expect, test } from 'vitest'
import {
  buildCommandMenu,
  commandById,
  trimDividers,
  COMMANDS,
  NEW_FILE_IDS,
  NEW_SUBMENU_IDS,
  type CommandContext
} from '../commands'
import { isDivider, type MenuItem, type MenuNode } from '../menu'

const t = (key: string): string => key
const rows = (nodes: MenuNode[]): MenuItem[] => nodes.filter((n) => !isDivider(n)) as MenuItem[]
const ids = (nodes: MenuNode[]): string[] => rows(nodes).map((n) => n.id)

const NO_PROJECT: CommandContext = { projectPath: null }
const IN_PROJECT: CommandContext = { projectPath: '/p/main.kicad_pro' }

describe('the registry itself', () => {
  test('every command has a unique id', () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
  })

  test('every command can say why it is disabled', () => {
    // A grayed row with no tooltip is the failure mode §4.2 exists to prevent:
    // the user sees a command they cannot run and is told nothing.
    for (const command of COMMANDS) {
      expect(command.disabledReason(t, NO_PROJECT)).toBeTruthy()
    }
  })

  test('every id named by a submenu resolves', () => {
    for (const id of [...NEW_SUBMENU_IDS, ...NEW_FILE_IDS]) {
      if (id !== null) expect(commandById(id)).toBeDefined()
    }
  })
})

describe('enablement', () => {
  test('every file create needs a project, not merely an open folder', () => {
    for (const id of NEW_FILE_IDS) {
      if (id === null) continue
      expect(commandById(id)?.enabledWhen(NO_PROJECT)).toBe(false)
      expect(commandById(id)?.enabledWhen(IN_PROJECT)).toBe(true)
    }
  })

  test('container creates need a target library, not a project', () => {
    const symbol = commandById('new:symbol')
    expect(symbol?.enabledWhen(IN_PROJECT)).toBe(false)
    expect(
      symbol?.enabledWhen({
        projectPath: null,
        target: { name: 'Device.kicad_sym', path: '/p/Device.kicad_sym', isDirectory: false }
      })
    ).toBe(true)

    const footprint = commandById('new:footprint')
    expect(
      footprint?.enabledWhen({
        projectPath: null,
        target: { name: 'House.pretty', path: '/p/House.pretty', isDirectory: true }
      })
    ).toBe(true)
  })

  test('Open needs a file, since a directory has nothing to open', () => {
    const open = commandById('file:open')
    expect(
      open?.enabledWhen({
        projectPath: null,
        target: { name: 'lib', path: '/p/lib', isDirectory: true }
      })
    ).toBe(false)
    expect(
      open?.enabledWhen({
        projectPath: null,
        target: { name: 'b.kicad_pcb', path: '/p/b.kicad_pcb', isDirectory: false }
      })
    ).toBe(true)
  })
})

describe('buildCommandMenu', () => {
  test('grays what cannot run, with the reason as a tooltip', () => {
    const [row] = rows(buildCommandMenu(['new:schematic'], NO_PROJECT, t))
    expect(row.disabled).toBe(true)
    expect(row.disabledReason).toBe('titleBar.menu.needsProject')
  })

  test('omits instead when the surface asks it to', () => {
    expect(buildCommandMenu(['new:schematic'], NO_PROJECT, t, { omitDisabled: true })).toEqual([])
  })

  test('shows an accelerator only when the surface resolves one', () => {
    const withHotkey = rows(
      buildCommandMenu(['new:schematic'], IN_PROJECT, t, { hotkeyLabel: () => 'Ctrl+N' })
    )
    expect(withHotkey[0].shortcut).toBe('Ctrl+N')
    expect(rows(buildCommandMenu(['new:schematic'], IN_PROJECT, t))[0].shortcut).toBeUndefined()
  })

  test('drops dividers that end up separating nothing', () => {
    // The `new:symbol` row disappears without a target, which would otherwise
    // leave the divider before it dangling at the end.
    const menu = buildCommandMenu(['new:schematic', null, 'new:symbol'], IN_PROJECT, t, {
      omitDisabled: true
    })
    expect(ids(menu)).toEqual(['new:schematic'])
    expect(menu.some(isDivider)).toBe(false)
  })

  test('ignores an id no command answers to', () => {
    expect(buildCommandMenu(['nope' as 'new:schematic'], IN_PROJECT, t)).toEqual([])
  })
})

describe('trimDividers', () => {
  test('removes leading, trailing, and doubled dividers', () => {
    const trimmed = trimDividers([
      { divider: true },
      { id: 'file:open', label: 'Open' },
      { divider: true },
      { divider: true },
      { id: 'file:delete', label: 'Delete' },
      { divider: true }
    ])
    expect(trimmed).toEqual([
      { id: 'file:open', label: 'Open' },
      { divider: true },
      { id: 'file:delete', label: 'Delete' }
    ])
  })
})
