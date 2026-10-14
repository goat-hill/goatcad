import { beforeEach, describe, expect, it } from 'vitest'
import { resetActivePane, useActivePane } from '../activePane'

describe('activePane', () => {
  beforeEach(() => resetActivePane())

  it('starts on the canvas — an editor opens ready to be drawn in', () => {
    expect(useActivePane().activePane.value).toBe('canvas')
  })

  it('is one answer for the window, shared by every consumer', () => {
    // Module scope is the point: the canvas and the properties panel are
    // separate components and must never disagree about which is active.
    const canvas = useActivePane()
    const panel = useActivePane()
    panel.setActivePane('properties')
    expect(canvas.activePane.value).toBe('properties')
  })

  it('tracks exactly one active pane, so only one surface reads as live', () => {
    const { isActivePane, setActivePane } = useActivePane()
    const canvasLive = isActivePane('canvas')
    const panelLive = isActivePane('properties')

    expect([canvasLive.value, panelLive.value]).toEqual([true, false])
    setActivePane('properties')
    expect([canvasLive.value, panelLive.value]).toEqual([false, true])
    setActivePane('canvas')
    expect([canvasLive.value, panelLive.value]).toEqual([true, false])
  })

  it('resets to the canvas on mount, so a new editor inherits nothing', () => {
    const { activePane, setActivePane } = useActivePane()
    setActivePane('properties')
    // Opening another file must not start with the previous editor's panel
    // still holding the keyboard.
    resetActivePane()
    expect(activePane.value).toBe('canvas')
  })
})
