import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPLORER_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  contextRailWidth,
  DEFAULT_SIDEBAR_WIDTH,
  PANEL_SECTION_MIN,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  explorerHeight,
  panelPinned,
  panelWidth,
  pinnedPanelId,
  resetPanelLayoutForTest,
  sectionState,
  setExplorerHeight,
  setPanelPinned,
  setPanelWidth,
  setSectionCollapsed,
  setSectionHeight,
  setSidebarWidth,
  sidebarWidth
} from '../panelLayout'

// No `window.api` here, which is the point: the store must work as an in-memory
// copy rather than throwing (RULES.md §8's "degrade gracefully").
beforeEach(() => resetPanelLayoutForTest())

describe('the right bar', () => {
  it('falls back to the default', () => {
    expect(panelWidth().value).toBe(DEFAULT_PANEL_WIDTH)
  })

  /** Clamped on WRITE, so a drag past the edge stops rather than storing junk. */
  it('clamps to the shared bounds', () => {
    setPanelWidth(10)
    expect(panelWidth().value).toBe(PANEL_WIDTH_MIN)
    setPanelWidth(5000)
    expect(panelWidth().value).toBe(PANEL_WIDTH_MAX)
  })

  it('rounds, so a fractional drag delta never reaches the config', () => {
    setPanelWidth(301.6)
    expect(panelWidth().value).toBe(302)
  })

  it('is one live source — every reader sees a write', () => {
    const a = panelWidth()
    const b = panelWidth()
    setPanelWidth(350)
    expect(a.value).toBe(350)
    expect(b.value).toBe(350)
  })
})

describe('collapsible sections', () => {
  /**
   * An untouched id stores NOTHING, which is what lets a panel change its
   * default height in a later release without every existing config pinning
   * the old one.
   */
  it('is empty for an id nothing has touched', () => {
    expect(sectionState('symbol.pins').value).toEqual({})
  })

  it('stores height and collapsed independently', () => {
    setSectionHeight('symbol.pins', 260)
    expect(sectionState('symbol.pins').value).toEqual({ height: 260 })
    setSectionCollapsed('symbol.pins', true)
    expect(sectionState('symbol.pins').value).toEqual({ height: 260, collapsed: true })
  })

  it('keeps ids apart', () => {
    setSectionHeight('pcb.layers', 200)
    setSectionHeight('footprint.layers', 300)
    expect(sectionState('pcb.layers').value.height).toBe(200)
    expect(sectionState('footprint.layers').value.height).toBe(300)
  })

  it('refuses a height that would hide the panel entirely', () => {
    setSectionHeight('pcb.layers', 5)
    expect(sectionState('pcb.layers').value.height).toBe(PANEL_SECTION_MIN)
  })

  it('has no upper bound — a stack of one may fill the bar', () => {
    setSectionHeight('pcb.layers', 1400)
    expect(sectionState('pcb.layers').value.height).toBe(1400)
  })
})

describe('the left bar', () => {
  it('falls back to its defaults', () => {
    expect(sidebarWidth().value).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(explorerHeight().value).toBe(DEFAULT_EXPLORER_HEIGHT)
  })

  it('clamps the width and floors the section height', () => {
    setSidebarWidth(20)
    expect(sidebarWidth().value).toBe(180)
    setSidebarWidth(9000)
    expect(sidebarWidth().value).toBe(500)
    setExplorerHeight(1)
    expect(explorerHeight().value).toBe(50)
  })

  it('tracks a drag without committing, then keeps the committed value', () => {
    setExplorerHeight(300)
    setExplorerHeight(320, true)
    expect(explorerHeight().value).toBe(320)
  })
})

describe('the width the shared rail is held at while an editor loads', () => {
  it('is the one rail width for every tab that fills the rail', () => {
    setPanelWidth(420, true)
    for (const type of [
      'pcb',
      'schematic',
      'library-symbol',
      'library-footprint',
      'gerber'
    ] as const) {
      expect(contextRailWidth(type)).toBe(420)
    }
  })

  it('tracks a drag, so resizing the panel never leaves the floor behind', () => {
    setPanelWidth(380)
    expect(contextRailWidth('schematic')).toBe(380)
  })

  it('is nothing for a tab that puts nothing in the rail', () => {
    // A text file, a PDF or a terminal collapses the rail legitimately, and
    // holding a floor open for one would leave a blank column beside it.
    expect(contextRailWidth('text')).toBe(0)
    expect(contextRailWidth('pdf')).toBe(0)
    expect(contextRailWidth('model3d')).toBe(0)
  })
})

describe('pinnable panels', () => {
  it('starts with Layers in the bar and everything else a pill', () => {
    expect(panelPinned('pcb', 'layers').value).toBe(true)
    for (const panel of ['filter', 'grid', 'health'] as const) {
      expect(panelPinned('pcb', panel).value).toBe(false)
    }
  })

  it('keeps a pin per editor, beside the section height it shares an id with', () => {
    setSectionHeight(pinnedPanelId('pcb', 'grid'), 150, true)
    setPanelPinned('pcb', 'grid', true)
    setPanelPinned('footprint', 'layers', false)
    expect(panelPinned('pcb', 'grid').value).toBe(true)
    expect(panelPinned('schematic', 'grid').value).toBe(false)
    expect(panelPinned('footprint', 'layers').value).toBe(false)
    expect(sectionState('pcb.grid').value).toEqual({ height: 150, pinned: true })
  })
})
