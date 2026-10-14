import { describe, expect, test } from 'vitest'
import {
  firstFocusableIndex,
  hasChildren,
  isDivider,
  isFocusable,
  isHeader,
  isMenuItem,
  keyedItemIndex,
  labelSegments,
  labelText,
  lastFocusableIndex,
  nextFocusableIndex,
  resolveMenuPosition,
  type MenuNode
} from '../menu'

const nodes: MenuNode[] = [
  { id: 'new', label: 'New', children: [{ id: 'sch', label: 'Schematic…' }] },
  { divider: true },
  { id: 'open', label: 'Open' },
  { id: 'child', label: 'Child Schematic…', disabled: true, disabledReason: 'No active sheet' },
  { id: 'save', label: 'Save' }
]

describe('node predicates', () => {
  test('classifies dividers, submenus, and focusability', () => {
    expect(isDivider(nodes[1])).toBe(true)
    expect(isDivider(nodes[0])).toBe(false)
    expect(hasChildren(nodes[0])).toBe(true)
    expect(hasChildren(nodes[2])).toBe(false)
    // A submenu parent with an empty child list is a dead end, not a submenu.
    expect(hasChildren({ id: 'x', label: 'X', children: [] })).toBe(false)
    expect(isFocusable(nodes[1])).toBe(false)
    expect(isFocusable(nodes[3])).toBe(false)
    expect(isFocusable(nodes[2])).toBe(true)
  })

  test('treats a section header as a label, never a row', () => {
    const header: MenuNode = { header: 'Projects' }
    expect(isHeader(header)).toBe(true)
    expect(isMenuItem(header)).toBe(false)
    expect(isDivider(header)).toBe(false)
    // Keyboard traversal must step over it, as it does a divider.
    expect(isFocusable(header)).toBe(false)
    expect(hasChildren(header)).toBe(false)
    expect(isHeader(nodes[2])).toBe(false)
  })

  test('steps over headers when moving through a grouped menu', () => {
    const grouped: MenuNode[] = [
      { header: 'Projects' },
      { id: 'a', label: 'a' },
      { divider: true },
      { header: 'Files' },
      { id: 'b', label: 'b' }
    ]
    expect(firstFocusableIndex(grouped)).toBe(1)
    expect(nextFocusableIndex(grouped, 1, 1)).toBe(4)
    expect(lastFocusableIndex(grouped)).toBe(4)
  })
})

describe('nextFocusableIndex', () => {
  test('skips dividers and disabled items going down', () => {
    expect(nextFocusableIndex(nodes, 0, 1)).toBe(2)
    expect(nextFocusableIndex(nodes, 2, 1)).toBe(4)
  })

  test('skips dividers and disabled items going up', () => {
    expect(nextFocusableIndex(nodes, 4, -1)).toBe(2)
    expect(nextFocusableIndex(nodes, 2, -1)).toBe(0)
  })

  test('wraps at both ends', () => {
    expect(nextFocusableIndex(nodes, 4, 1)).toBe(0)
    expect(nextFocusableIndex(nodes, 0, -1)).toBe(4)
  })

  test('opening with the keyboard lands on the first and last focusable rows', () => {
    expect(firstFocusableIndex(nodes)).toBe(0)
    expect(lastFocusableIndex(nodes)).toBe(4)
    expect(firstFocusableIndex([{ divider: true }, { id: 'a', label: 'A' }])).toBe(1)
    expect(lastFocusableIndex([{ id: 'a', label: 'A' }, { divider: true }])).toBe(0)
  })

  test('returns -1 when nothing can take focus', () => {
    expect(nextFocusableIndex([], 0, 1)).toBe(-1)
    expect(nextFocusableIndex([{ divider: true }], 0, 1)).toBe(-1)
    expect(firstFocusableIndex([{ id: 'a', label: 'A', disabled: true }])).toBe(-1)
  })
})

describe('resolveMenuPosition', () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 800, width: 200, height: 300 }

  test('leaves a fitting menu where it was asked for', () => {
    expect(resolveMenuPosition({ ...viewport, x: 100, y: 100 })).toEqual({ x: 100, y: 100 })
  })

  test('clamps a top-level menu back inside the right and bottom edges', () => {
    expect(resolveMenuPosition({ ...viewport, x: 900, y: 700 })).toEqual({ x: 796, y: 496 })
  })

  test('flips a submenu to the left of its anchor rather than covering it', () => {
    // Parent item spans to x=880; the submenu would overflow, so it opens leftward.
    const placed = resolveMenuPosition({ ...viewport, x: 880, y: 100, flipAnchorX: 700 })
    expect(placed).toEqual({ x: 500, y: 100 })
  })

  test('never places a menu off the top-left, even when taller than the viewport', () => {
    const placed = resolveMenuPosition({
      ...viewport,
      height: 900,
      x: 10,
      y: 400,
      margin: 4
    })
    expect(placed).toEqual({ x: 10, y: 4 })
  })
})

describe('label segments', () => {
  const segmented = [
    { text: 'Add symbol library ' },
    { text: '.kicad_sym', code: true },
    { text: ' to project…' }
  ]

  test('wraps a plain string as a single non-code segment', () => {
    expect(labelSegments('Rename')).toEqual([{ text: 'Rename' }])
  })

  test('passes segments through unchanged', () => {
    expect(labelSegments(segmented)).toBe(segmented)
  })

  test('flattens to plain text without inserting separators', () => {
    // The joined form is what tooltips and accessibility surfaces read, so the
    // spacing has to live in the segments themselves — not in the join.
    expect(labelText(segmented)).toBe('Add symbol library .kicad_sym to project…')
    expect(labelText('Rename')).toBe('Rename')
  })
})

describe('keyedItemIndex', () => {
  // Select Other's rows: 1–9 pick a row, A takes them all.
  const nodes: MenuNode[] = [
    { header: 'Select' },
    { id: '0', label: 'Track', key: '1' },
    { id: '1', label: 'Via', key: '2', disabled: true },
    { id: 'sub', label: 'More', key: '3', children: [{ id: 'x', label: 'X' }] },
    { divider: true },
    { id: 'all', label: 'Select all', key: 'a' }
  ]

  test('a key picks the row that names it, whatever its case', () => {
    expect(keyedItemIndex(nodes, { key: '1' })).toBe(1)
    expect(keyedItemIndex(nodes, { key: 'a' })).toBe(5)
    expect(keyedItemIndex(nodes, { key: 'A' })).toBe(5)
  })

  test('a disabled row or one with a submenu is not picked', () => {
    expect(keyedItemIndex(nodes, { key: '2' })).toBe(-1)
    expect(keyedItemIndex(nodes, { key: '3' })).toBe(-1)
  })

  test('a modified press or a named key keeps its own meaning', () => {
    expect(keyedItemIndex(nodes, { key: 'a', ctrlKey: true })).toBe(-1)
    expect(keyedItemIndex(nodes, { key: 'a', metaKey: true })).toBe(-1)
    expect(keyedItemIndex(nodes, { key: 'a', altKey: true })).toBe(-1)
    expect(keyedItemIndex(nodes, { key: 'Enter' })).toBe(-1)
  })

  test('a key no row names picks nothing', () => {
    expect(keyedItemIndex(nodes, { key: 'z' })).toBe(-1)
  })
})
