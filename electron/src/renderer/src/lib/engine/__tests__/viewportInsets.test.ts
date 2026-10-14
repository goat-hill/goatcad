import { describe, it, expect } from 'vitest'
import { measureViewportInsets, VIEW_COMFORT_PX } from '../viewportInsets'

// The suite runs in the node environment, so the two DOM calls this module
// makes — `getBoundingClientRect` and `querySelectorAll` — are stood up by
// hand rather than through jsdom.

type Rect = { top: number; right: number; bottom: number; left: number }

const rectOf = (r: Rect): DOMRect =>
  ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) as DOMRect

const chrome = (r: Rect, hidden = false): HTMLElement =>
  ({
    getBoundingClientRect: () => rectOf(r),
    offsetParent: hidden ? null : {}
  }) as unknown as HTMLElement

/** An 800×600 canvas at the page origin, with the named chrome over it. */
const host = (elements: Record<string, HTMLElement[]>): HTMLElement =>
  ({
    getBoundingClientRect: () => rectOf({ top: 0, left: 0, right: 800, bottom: 600 }),
    querySelectorAll: (selector: string) => elements[selector] ?? []
  }) as unknown as HTMLElement

describe('measureViewportInsets', () => {
  it('is the comfort margin alone when nothing floats over the canvas', () => {
    expect(measureViewportInsets(host({}), ['.toolbar'])).toEqual({
      top: VIEW_COMFORT_PX,
      right: VIEW_COMFORT_PX,
      bottom: VIEW_COMFORT_PX,
      left: VIEW_COMFORT_PX
    })
  })

  it('charges the top-left tool pill to the TOP, where it costs least', () => {
    // 12px in from both corners, 220 wide and 40 tall: a top toolbar, which
    // nothing has to declare — 52px of top beats 232px of left.
    const pill = chrome({ top: 12, left: 12, right: 232, bottom: 52 })
    const insets = measureViewportInsets(host({ '.canvas-floating-toolbar': [pill] }), [
      '.canvas-floating-toolbar'
    ])
    expect(insets.top).toBe(52 + VIEW_COMFORT_PX)
    expect(insets.left).toBe(VIEW_COMFORT_PX)
  })

  it('charges the left view rail to the LEFT', () => {
    // The board's rail: 12px from the left, 44 wide, starting 64px down.
    const rail = chrome({ top: 64, left: 12, right: 56, bottom: 300 })
    const insets = measureViewportInsets(host({ '.rail': [rail] }), ['.rail'])
    expect(insets.left).toBe(56 + VIEW_COMFORT_PX)
    expect(insets.top).toBe(VIEW_COMFORT_PX)
  })

  it('charges a status pill to the BOTTOM', () => {
    const pill = chrome({ top: 564, left: 12, right: 200, bottom: 588 })
    const insets = measureViewportInsets(host({ '.pill': [pill] }), ['.pill'])
    expect(insets.bottom).toBe(600 - 564 + VIEW_COMFORT_PX)
    expect(insets.left).toBe(VIEW_COMFORT_PX)
  })

  it('keeps the deepest intrusion per edge across several elements', () => {
    const shallow = chrome({ top: 12, left: 12, right: 200, bottom: 40 })
    const deep = chrome({ top: 12, left: 300, right: 500, bottom: 70 })
    const insets = measureViewportInsets(host({ '.t': [shallow, deep] }), ['.t'])
    expect(insets.top).toBe(70 + VIEW_COMFORT_PX)
  })

  it('ignores hidden chrome', () => {
    const pill = chrome({ top: 12, left: 12, right: 232, bottom: 52 }, true)
    expect(measureViewportInsets(host({ '.t': [pill] }), ['.t']).top).toBe(VIEW_COMFORT_PX)
  })

  it('ignores chrome that misses the canvas — the other half of a 2D/3D swap', () => {
    const elsewhere = chrome({ top: -200, left: 12, right: 232, bottom: -100 })
    expect(measureViewportInsets(host({ '.t': [elsewhere] }), ['.t']).top).toBe(VIEW_COMFORT_PX)
  })

  it('caps insets so a narrow pane keeps a usable safe rect', () => {
    // Chrome covering most of the canvas would otherwise collapse the safe
    // rect and send every reveal down the zoom-out branch.
    const huge = chrome({ top: 0, left: 0, right: 790, bottom: 590 })
    const insets = measureViewportInsets(host({ '.t': [huge] }), ['.t'])
    expect(insets.top).toBeLessThanOrEqual(600 * 0.4)
    expect(insets.left).toBeLessThanOrEqual(800 * 0.4)
  })

  it('measures chrome that is not a child of the canvas host', () => {
    // The board's toolbars are siblings of its canvas: they live in
    // PcbEditor.vue so they survive the 2D/3D swap.
    const pill = chrome({ top: 12, left: 12, right: 232, bottom: 52 })
    const insets = measureViewportInsets(host({}), ['.t'], host({ '.t': [pill] }))
    expect(insets.top).toBe(52 + VIEW_COMFORT_PX)
  })

  it('survives a container with no layout yet', () => {
    const collapsed = {
      getBoundingClientRect: () => rectOf({ top: 0, left: 0, right: 0, bottom: 0 }),
      querySelectorAll: () => []
    } as unknown as HTMLElement
    expect(measureViewportInsets(collapsed, ['.t']).top).toBe(VIEW_COMFORT_PX)
    expect(measureViewportInsets(null, ['.t']).top).toBe(VIEW_COMFORT_PX)
  })
})
