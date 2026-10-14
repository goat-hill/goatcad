import { describe, expect, it } from 'vitest'
import { activate, createLayout, reconcile, sendToOtherGroup } from '../editorGroups'
import { routeCrossProbe } from '../crossProbeRoute'
import { boardProbeTargets, footprintIndicesFor, symbolUuidOfFootprint } from '../crossProbe'
import { parseKicadBoard } from '../kicad/board'

const tab = (path: string): { name: string; path: string } => ({
  name: path.split('/').pop() ?? path,
  path
})

const SCH = '/p/main.kicad_sch'
const POWER = '/p/power.kicad_sch'
const PCB = '/p/main.kicad_pcb'
const TERM = 'goatcad://terminal/claude/1'

/** Left group: `left`; right group: `right`, its first entry in front. */
const split = (left: string[], right: string[]): ReturnType<typeof createLayout> => {
  const paths = [...left, ...right]
  const layout = createLayout()
  reconcile(layout, paths)
  for (const path of right) {
    sendToOtherGroup(layout, path, paths)
    reconcile(layout, paths)
  }
  activate(layout, right[0])
  activate(layout, left[0])
  return layout
}

describe('routeCrossProbe', () => {
  it('sends a schematic selection to the board across the split', () => {
    const layout = split([SCH], [PCB])
    const tabs = [SCH, PCB].map(tab)
    expect(routeCrossProbe(layout, tabs, 'pcb', null, layout.groups[0].id)).toEqual({
      groupId: layout.groups[1].id,
      path: PCB,
      action: 'show'
    })
  })

  it('never answers in the pane the selection was made in', () => {
    const layout = createLayout()
    reconcile(layout, [SCH, PCB])
    const tabs = [SCH, PCB].map(tab)
    expect(routeCrossProbe(layout, tabs, 'pcb', null, layout.groups[0].id)).toBeNull()
  })

  it('leaves a board behind an agent terminal where it is', () => {
    const layout = split([SCH], [TERM, PCB])
    const tabs = [SCH, TERM, PCB].map(tab)
    expect(routeCrossProbe(layout, tabs, 'pcb', null, layout.groups[0].id)).toBeNull()
  })

  it('leaves a sheet behind an agent terminal where it is', () => {
    const layout = split([PCB], [TERM, SCH])
    const tabs = [PCB, TERM, SCH].map(tab)
    expect(routeCrossProbe(layout, tabs, 'schematic', SCH, layout.groups[0].id)).toBeNull()
  })

  it('opens the right sheet in a pane that is showing a schematic', () => {
    const layout = split([PCB], [SCH])
    const tabs = [PCB, SCH].map(tab)
    expect(routeCrossProbe(layout, tabs, 'schematic', POWER, layout.groups[0].id)).toEqual({
      groupId: layout.groups[1].id,
      path: POWER,
      action: 'open'
    })
  })

  it('switches to a sheet already open behind the one showing', () => {
    const layout = split([PCB], [SCH, POWER])
    const tabs = [PCB, SCH, POWER].map(tab)
    expect(routeCrossProbe(layout, tabs, 'schematic', POWER, layout.groups[0].id)).toEqual({
      groupId: layout.groups[1].id,
      path: POWER,
      action: 'show'
    })
  })

  it('moves a sheet open behind the board over to the schematic pane, never twice', () => {
    const layout = split([PCB, POWER], [SCH])
    const tabs = [PCB, POWER, SCH].map(tab)
    expect(routeCrossProbe(layout, tabs, 'schematic', POWER, layout.groups[0].id)).toEqual({
      groupId: layout.groups[1].id,
      path: POWER,
      action: 'move'
    })
  })

  it('does nothing for a sheet behind the board when no pane shows a schematic', () => {
    const layout = split([PCB, POWER], [TERM])
    const tabs = [PCB, POWER, TERM].map(tab)
    expect(routeCrossProbe(layout, tabs, 'schematic', POWER, layout.groups[0].id)).toBeNull()
  })

  it('leaves a pane showing something else alone', () => {
    const layout = split([PCB], [TERM])
    const tabs = [PCB, TERM].map(tab)
    expect(routeCrossProbe(layout, tabs, 'schematic', POWER, layout.groups[0].id)).toBeNull()
  })

  it('takes any group for a probe from another window', () => {
    const layout = createLayout()
    reconcile(layout, [PCB])
    expect(routeCrossProbe(layout, [tab(PCB)], 'pcb', null, null)?.path).toBe(PCB)
  })
})

const BOARD = `(kicad_pcb (version 20240108) (generator "test")
  (footprint "R:R_0603" (layer "F.Cu") (uuid "f1") (at 10 10)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "p1"))
    (path "/aaaa/bbbb") (sheetname "/Power/") (sheetfile "sub/power.kicad_sch"))
  (footprint "C:C_0603" (layer "F.Cu") (uuid "f2") (at 20 10)
    (property "Reference" "C1" (at 0 0) (layer "F.SilkS") (uuid "p2"))
    (path "/cccc") (sheetname "/") (sheetfile "main.kicad_sch"))
)`

describe('cross-probe links', () => {
  const board = parseKicadBoard(BOARD)

  it('reads the symbol uuid off the end of a footprint path', () => {
    expect(board.footprints.map(symbolUuidOfFootprint)).toEqual(['bbbb', 'cccc'])
  })

  it('names the sheet beside the board', () => {
    expect(boardProbeTargets(board, PCB, [0])).toEqual([
      { symbolUuid: 'bbbb', sheetFile: '/p/sub/power.kicad_sch' }
    ])
  })

  it('finds footprints by uuid, and by reference only when no uuid matches', () => {
    expect(footprintIndicesFor(board, ['cccc'], ['R1'])).toEqual([1])
    expect(footprintIndicesFor(board, ['other-unit'], ['R1'])).toEqual([0])
    expect(footprintIndicesFor(board, ['other-unit'], ['R?'])).toEqual([])
  })
})
