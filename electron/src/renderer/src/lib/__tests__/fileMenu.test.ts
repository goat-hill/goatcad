import { describe, expect, test } from 'vitest'
import { buildFileTreeMenu, siblingNames, validateFileName, type FileTreeItem } from '../fileMenu'
import { isDivider, type MenuItem, type MenuNode } from '../menu'
import type { CommandContext } from '../commands'

const t = (key: string): string => key
const ids = (nodes: MenuNode[]): string[] =>
  nodes.filter((n) => !isDivider(n)).map((n) => (n as MenuItem).id)

const PROJECT: Pick<CommandContext, 'projectPath'> = { projectPath: '/p/main.kicad_pro' }

describe('buildFileTreeMenu', () => {
  test('offers Open for files', () => {
    expect(
      ids(buildFileTreeMenu({ name: 'board.kicad_pcb', isDirectory: false }, t, PROJECT))
    ).toEqual(['file:open', 'new', 'file:reveal', 'file:copy-path', 'file:rename', 'file:delete'])
  })

  test('promotes New Symbol onto a .kicad_sym row, and nowhere else', () => {
    expect(
      ids(buildFileTreeMenu({ name: 'Device.kicad_sym', isDirectory: false }, t, PROJECT))
    ).toEqual([
      'file:open',
      'new:symbol',
      'new',
      'file:reveal',
      'file:copy-path',
      'file:rename',
      'file:delete'
    ])
    expect(
      ids(buildFileTreeMenu({ name: 'board.kicad_pcb', isDirectory: false }, t, PROJECT))
    ).not.toContain('new:symbol')
  })

  test('promotes New Footprint on a .pretty, and offers no other create there', () => {
    // A `.pretty` holds footprints and nothing else, so the generic `New ▸`
    // would offer three creates that do not belong in it.
    expect(ids(buildFileTreeMenu({ name: 'House.pretty', isDirectory: true }, t, PROJECT))).toEqual(
      ['new:footprint', 'file:reveal', 'file:copy-path', 'file:rename', 'file:delete']
    )
  })

  test('offers New Footprint nowhere else', () => {
    expect(
      ids(buildFileTreeMenu({ name: 'board.kicad_pcb', isDirectory: false }, t, PROJECT))
    ).not.toContain('new:footprint')
    // A plain folder is not a footprint library, whatever it holds.
    expect(ids(buildFileTreeMenu({ name: 'lib', isDirectory: true }, t, PROJECT))).not.toContain(
      'new:footprint'
    )
  })

  test('the project scope drops the two filesystem actions', () => {
    // Where a file sits on disk is the explorer's question; everything that
    // acts on the design itself stays.
    expect(
      ids(buildFileTreeMenu({ name: 'sheet.kicad_sch', isDirectory: false }, t, PROJECT, 'project'))
    ).toEqual(['file:open', 'file:rename', 'file:delete'])
  })

  test('a project row offers only creates that belong INSIDE it', () => {
    // A footprint is a part of the design, not a place: `New ▸ Schematic` there
    // would read as "a schematic goes inside this footprint".
    const leaf = buildFileTreeMenu(
      { name: 'SOT-23-6.kicad_mod', isDirectory: false },
      t,
      PROJECT,
      'project'
    )
    expect(ids(leaf)).toEqual(['file:open', 'file:rename', 'file:delete'])
    // The two container creates are what a row CAN hold, so they stay.
    expect(
      ids(buildFileTreeMenu({ name: 'House.pretty', isDirectory: true }, t, PROJECT, 'project'))
    ).toEqual(['new:footprint', 'file:rename', 'file:delete'])
    expect(
      ids(
        buildFileTreeMenu({ name: 'Device.kicad_sym', isDirectory: false }, t, PROJECT, 'project')
      )
    ).toEqual(['file:open', 'new:symbol', 'file:rename', 'file:delete'])
  })

  test('omits Open for directories — clicking one expands it, it never opens a tab', () => {
    expect(ids(buildFileTreeMenu({ name: 'lib', isDirectory: true }, t, PROJECT))).toEqual([
      'new',
      'file:reveal',
      'file:copy-path',
      'file:rename',
      'file:delete'
    ])
  })

  const newChildren = (
    target: { name: string; isDirectory: boolean },
    ctx = PROJECT
  ): MenuNode[] => {
    const menu = buildFileTreeMenu(target, t, ctx)
    const item = menu.find((node) => !isDivider(node) && (node as MenuItem).id === 'new') as
      MenuItem | undefined
    return item?.children ?? []
  }

  test('New is a submenu of file kinds, offered from files and folders alike', () => {
    expect(ids(newChildren({ name: 'lib', isDirectory: true }))).toEqual([
      'new:schematic',
      'new:board',
      'new:symbol-library'
    ])
    expect(ids(newChildren({ name: 'board.kicad_pcb', isDirectory: false }))).toEqual([
      'new:schematic',
      'new:board',
      'new:symbol-library'
    ])
  })

  test('grays the creates without a project rather than hiding them', () => {
    const rows = newChildren({ name: 'lib', isDirectory: true }, { projectPath: null }).filter(
      (node) => !isDivider(node)
    ) as MenuItem[]
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.disabled)).toBe(true)
    expect(rows.every((row) => !!row.disabledReason)).toBe(true)
  })

  test('never renders a leading, trailing, or doubled divider', () => {
    const menu = buildFileTreeMenu({ name: 'lib', isDirectory: true }, t, PROJECT)
    expect(isDivider(menu[0])).toBe(false)
    expect(isDivider(menu[menu.length - 1])).toBe(false)
    expect(menu.some((node, i) => i > 0 && isDivider(node) && isDivider(menu[i - 1]))).toBe(false)
  })
})

describe('siblingNames', () => {
  const tree: FileTreeItem[] = [
    { name: 'main.kicad_sch', path: '/p/main.kicad_sch', isDirectory: false },
    {
      name: 'lib',
      path: '/p/lib',
      isDirectory: true,
      children: [
        { name: 'parts.kicad_sym', path: '/p/lib/parts.kicad_sym', isDirectory: false },
        { name: 'extra.kicad_sym', path: '/p/lib/extra.kicad_sym', isDirectory: false }
      ]
    }
  ]

  test('returns the node’s peers, excluding itself', () => {
    expect(siblingNames(tree, '/p/main.kicad_sch')).toEqual(['lib'])
    expect(siblingNames(tree, '/p/lib/parts.kicad_sym')).toEqual(['extra.kicad_sym'])
  })

  test('returns nothing for a path not in the tree', () => {
    expect(siblingNames(tree, '/p/missing.kicad_sch')).toEqual([])
  })
})

describe('validateFileName', () => {
  const siblings = ['main.kicad_sch', 'board.kicad_pcb']

  test('accepts a fresh, well-formed name', () => {
    expect(validateFileName('power.kicad_sch', siblings)).toBeNull()
  })

  test('rejects empty and whitespace-only names', () => {
    expect(validateFileName('', siblings)).toBe('empty')
    expect(validateFileName('   ', siblings)).toBe('empty')
  })

  test('rejects path separators on both platforms', () => {
    expect(validateFileName('sub/file.kicad_sch', siblings)).toBe('separator')
    expect(validateFileName('sub\\file.kicad_sch', siblings)).toBe('separator')
  })

  test('rejects Windows device names regardless of extension or case', () => {
    expect(validateFileName('CON.kicad_sch', siblings)).toBe('reserved')
    expect(validateFileName('lpt1', siblings)).toBe('reserved')
    expect(validateFileName('console.kicad_sch', siblings)).toBeNull()
  })

  test('rejects trailing dots and surrounding whitespace', () => {
    expect(validateFileName('board.', siblings)).toBe('dots')
    expect(validateFileName(' board.kicad_pcb', siblings)).toBe('dots')
  })

  test('rejects a collision, including one that differs only by case', () => {
    expect(validateFileName('board.kicad_pcb', siblings)).toBe('exists')
    // Linux would allow this; macOS/Windows would silently clobber, so it is
    // refused everywhere rather than behaving differently per platform.
    expect(validateFileName('BOARD.kicad_pcb', siblings)).toBe('exists')
  })

  test('allows re-casing a file to its own name', () => {
    expect(validateFileName('Board.kicad_pcb', siblings, 'board.kicad_pcb')).toBeNull()
    expect(validateFileName('main.kicad_sch', siblings, 'board.kicad_pcb')).toBe('exists')
  })
})
