import { describe, it, expect } from 'vitest'
import { bringIntoViewMove, type BringIntoViewInput } from '../bringIntoView'

// A 800×600 pane at 10 px/mm shows 80×60 mm, centered on the origin.
const BASE: BringIntoViewInput = {
  target: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
  visible: { minX: -40, minY: -30, maxX: 40, maxY: 30 },
  zoom: 10,
  viewport: { width: 800, height: 600 },
  insets: { top: 0, right: 0, bottom: 0, left: 0 }
}

const at = (patch: Partial<BringIntoViewInput>): BringIntoViewInput => ({ ...BASE, ...patch })

/** Shift `visible` as a camera pan would, so the two stay consistent. */
const panned = (dx: number, dy: number): BringIntoViewInput['visible'] => ({
  minX: BASE.visible.minX + dx,
  maxX: BASE.visible.maxX + dx,
  minY: BASE.visible.minY + dy,
  maxY: BASE.visible.maxY + dy
})

describe('bringIntoViewMove', () => {
  describe('already in view', () => {
    it('does nothing for a part in the middle of the pane', () => {
      expect(bringIntoViewMove(BASE)).toEqual({ kind: 'none' })
    })

    it('does nothing for a part near an edge but clear of the chrome', () => {
      // 30 px of chrome on the left is 3 mm; the part sits at x ∈ [-35, -33].
      const move = bringIntoViewMove(
        at({
          target: { minX: -35, minY: -1, maxX: -33, maxY: 1 },
          insets: { top: 0, right: 0, bottom: 0, left: 30 }
        })
      )
      expect(move).toEqual({ kind: 'none' })
    })

    it('holds the view across a run of probes on different visible parts', () => {
      for (const x of [-30, -10, 0, 12, 33]) {
        const move = bringIntoViewMove(at({ target: { minX: x, minY: -1, maxX: x + 1, maxY: 1 } }))
        expect(move.kind).toBe('none')
      }
    })
  })

  describe('out of view', () => {
    it('pans without touching the zoom', () => {
      const move = bringIntoViewMove(at({ target: { minX: 100, minY: 0, maxX: 102, maxY: 2 } }))
      expect(move).toEqual({ kind: 'pan', x: 101, y: 1 })
    })

    it('pans for a part hidden UNDER the chrome, not merely off the canvas', () => {
      // A 52 px top toolbar is 5.2 mm. The part at y ∈ [27, 28] is on screen
      // (the pane reaches y = 30) and behind the toolbar, so it is not in view.
      const insets = { top: 52, right: 0, bottom: 0, left: 0 }
      const target = { minX: -1, minY: 27, maxX: 1, maxY: 28 }
      expect(bringIntoViewMove(at({ target, insets })).kind).toBe('pan')
      // With no chrome the same part is simply visible.
      expect(bringIntoViewMove(at({ target })).kind).toBe('none')
    })

    it('centers on the CANVAS, never offset to balance lopsided chrome', () => {
      // Whatever the insets, the part lands dead center: the chrome is paid
      // for in the zoom, not by parking the part off to one side.
      for (const insets of [
        { top: 0, right: 0, bottom: 0, left: 100 },
        { top: 100, right: 0, bottom: 0, left: 0 },
        { top: 0, right: 0, bottom: 100, left: 0 },
        { top: 52, right: 24, bottom: 44, left: 60 }
      ]) {
        const move = bringIntoViewMove(
          at({ target: { minX: 100, minY: 20, maxX: 102, maxY: 24 }, insets })
        )
        expect(move).toEqual({ kind: 'pan', x: 101, y: 22 })
      }
    })

    it('is stable: panning to a part leaves it in view, chrome and all', () => {
      // The reason `fits` is measured against the CENTERED rectangle. A part
      // that only fits the lopsided gap would land under the chrome when
      // centered on the canvas, and the next probe would ask to move it again.
      const target = { minX: 100, minY: 40, maxX: 102, maxY: 42 }
      for (const insets of [
        { top: 0, right: 0, bottom: 0, left: 0 },
        { top: 52, right: 24, bottom: 44, left: 200 }
      ]) {
        const first = bringIntoViewMove(at({ target, insets }))
        expect(first.kind).toBe('pan')
        if (first.kind !== 'pan') return
        const again = bringIntoViewMove(at({ target, insets, visible: panned(first.x, first.y) }))
        expect(again).toEqual({ kind: 'none' })
      }
    })

    it('settles a wide part that only the lopsided gap would hold', () => {
      // 200px left rail: the asymmetric gap is 576px but the largest centered
      // rectangle is 400px, so a 50 mm (500px) part goes to the fit branch
      // rather than panning under the rail.
      const insets = { top: 0, right: 24, bottom: 0, left: 200 }
      const target = { minX: 100, minY: -1, maxX: 150, maxY: 1 }
      const move = bringIntoViewMove(at({ target, insets }))
      expect(move.kind).toBe('fit')
      if (move.kind !== 'fit') return
      expect(move).toMatchObject({ x: 125, y: 0 })
      const again = bringIntoViewMove(
        at({
          target,
          insets,
          zoom: move.zoom,
          visible: {
            minX: move.x - 400 / move.zoom,
            maxX: move.x + 400 / move.zoom,
            minY: move.y - 300 / move.zoom,
            maxY: move.y + 300 / move.zoom
          }
        })
      )
      expect(again).toEqual({ kind: 'none' })
    })
  })

  describe('too big to fit', () => {
    it('zooms out, never in', () => {
      // 200 mm across in a pane showing 80 mm.
      const move = bringIntoViewMove(at({ target: { minX: -100, minY: -5, maxX: 100, maxY: 5 } }))
      expect(move.kind).toBe('fit')
      if (move.kind !== 'fit') return
      expect(move.zoom).toBeLessThan(BASE.zoom)
      // 800 px / (200 mm × 1.3) — no chrome, so the centered rectangle is the canvas.
      expect(move.zoom).toBeCloseTo(800 / (200 * 1.3), 6)
      expect(move).toMatchObject({ x: 0, y: 0 })
    })

    it('never zooms IN, however small the target', () => {
      // A part 0.02 mm across would fit the pane a thousand times over; the
      // zoom is untouched because it already fits. This is the whole promise.
      const move = bringIntoViewMove(
        at({ target: { minX: 39.99, minY: 0, maxX: 40.01, maxY: 0.02 } })
      )
      expect(move.kind).not.toBe('fit')
    })

    it('solves against the centered rectangle, not the whole canvas', () => {
      // 150 px of chrome on each side leaves a 500 px centered rectangle.
      const move = bringIntoViewMove(
        at({
          target: { minX: -100, minY: -5, maxX: 100, maxY: 5 },
          insets: { top: 0, right: 150, bottom: 0, left: 150 }
        })
      )
      expect(move.kind).toBe('fit')
      if (move.kind !== 'fit') return
      expect(move.zoom).toBeCloseTo(500 / (200 * 1.3), 6)
    })

    it('charges twice the LARGER inset, not the sum, since the part stays centered', () => {
      // 200 left / 0 right: a centered rectangle can only be 400 px wide, not
      // the 600 px the gap between the two edges would suggest.
      const move = bringIntoViewMove(
        at({
          target: { minX: -100, minY: -5, maxX: 100, maxY: 5 },
          insets: { top: 0, right: 0, bottom: 0, left: 200 }
        })
      )
      expect(move.kind).toBe('fit')
      if (move.kind !== 'fit') return
      expect(move.zoom).toBeCloseTo(400 / (200 * 1.3), 6)
    })

    it('honours the zoom floor', () => {
      const move = bringIntoViewMove(
        at({ target: { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }, minZoom: 2 })
      )
      expect(move).toMatchObject({ kind: 'fit', zoom: 2 })
    })

    it('floors a degenerate box with minExtent instead of dividing by zero', () => {
      // A zero-size target only reaches this branch when the safe rect has
      // collapsed; minExtent is what keeps the answer finite.
      const move = bringIntoViewMove(
        at({
          target: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          insets: { top: 300, right: 400, bottom: 300, left: 400 },
          minExtent: 30
        })
      )
      expect(move.kind).toBe('fit')
      if (move.kind !== 'fit') return
      expect(Number.isFinite(move.zoom)).toBe(true)
      expect(move.zoom).toBeLessThanOrEqual(BASE.zoom)
    })

    it('unions a scattered multi-select by zooming out rather than picking one', () => {
      // Two parts at opposite corners of a big board: the caller passes their
      // union, and the result holds both.
      const move = bringIntoViewMove(at({ target: { minX: -60, minY: -45, maxX: 60, maxY: 45 } }))
      expect(move.kind).toBe('fit')
      if (move.kind !== 'fit') return
      expect(move.zoom).toBeLessThan(BASE.zoom)
    })
  })

  describe('degenerate inputs', () => {
    it('does nothing at a zero or negative zoom', () => {
      expect(bringIntoViewMove(at({ zoom: 0 }))).toEqual({ kind: 'none' })
    })

    it('treats a pane smaller than its own chrome as a fit', () => {
      const move = bringIntoViewMove(
        at({ insets: { top: 400, right: 500, bottom: 400, left: 500 }, minExtent: 30 })
      )
      expect(move.kind).toBe('fit')
    })
  })
})
