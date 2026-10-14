import { describe, expect, it } from 'vitest'
import {
  fitViewOp,
  FIT_VIEW_OP_ID,
  filterToolSearchOps,
  layoutToolSearch,
  toolSearchRowsFor,
  type ToolbarSearchOp,
  type ToolSearchGroup
} from '../toolSearch'

const op = (id: string, group: ToolSearchGroup): ToolbarSearchOp => ({
  id,
  group,
  icon: 'tool-line',
  label: id
})

describe('layoutToolSearch', () => {
  it('orders groups by the registry, not by input order, and splits Edit from View', () => {
    const layout = layoutToolSearch([
      op('flip', 'layers'),
      op('line', 'draw'),
      op('sketchPads', 'display'),
      op('undo', 'place')
    ])
    expect(layout.sections.map((s) => s.section)).toEqual(['edit', 'view'])
    expect(layout.ops.map((o) => o.id)).toEqual(['undo', 'line', 'sketchPads', 'flip'])
    expect(layout.groupStarts).toEqual([0, 1, 2, 3])
  })

  it('keeps an op order within its group and indexes ops in keyboard order', () => {
    const layout = layoutToolSearch([op('redo', 'place'), op('undo', 'place')])
    const group = layout.sections[0].columns[0][0]
    expect(group.ops.map(({ op, index }) => [op.id, index])).toEqual([
      ['redo', 0],
      ['undo', 1]
    ])
  })

  it('starts a new column when the next group would overflow, never splitting a group', () => {
    const ops = [
      op('undo', 'place'),
      op('redo', 'place'),
      op('select', 'select'),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => op(id, 'draw'))
    ]
    const [edit] = layoutToolSearch(ops, 10).sections
    expect(edit.columns.map((column) => column.map((g) => g.group))).toEqual([
      ['select', 'place'],
      ['draw']
    ])
  })

  it('omits groups and sections with no ops', () => {
    const layout = layoutToolSearch([op('pin', 'place')])
    expect(layout.sections).toHaveLength(1)
    expect(layout.sections[0].columns).toEqual([[{ group: 'place', ops: [expect.anything()] }]])
    expect(layoutToolSearch([]).sections).toEqual([])
  })
})

describe('filterToolSearchOps', () => {
  it('matches the label case-insensitively and returns everything for a blank query', () => {
    const ops = [op('Sketch pads', 'display'), op('Line', 'draw')]
    expect(filterToolSearchOps(ops, '  ')).toBe(ops)
    expect(filterToolSearchOps(ops, 'SKETCH').map((o) => o.id)).toEqual(['Sketch pads'])
  })
})

describe('toolSearchRowsFor', () => {
  it('fits whole rows below the section chrome, never fewer than a minimum', () => {
    expect(toolSearchRowsFor(40 + 36 * 12 + 35)).toBe(12)
    expect(toolSearchRowsFor(100)).toBe(4)
  })
})

describe('fitViewOp', () => {
  it('is the fit chip in the View section, ahead of the display toggles', () => {
    const fit = fitViewOp('Zoom to fit', 'Home')
    expect(fit).toEqual({
      id: FIT_VIEW_OP_ID,
      icon: 'tool-fit',
      label: 'Zoom to fit',
      group: 'navigate',
      hotkey: 'Home'
    })
    const layout = layoutToolSearch([op('sketchPads', 'display'), fit, op('undo', 'place')])
    expect(layout.sections.map((s) => s.section)).toEqual(['edit', 'view'])
    expect(layout.ops.map((o) => o.id)).toEqual(['undo', FIT_VIEW_OP_ID, 'sketchPads'])
  })
})
