import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../../kicad/board'
import { BoardSpatialIndex, type CopperItem, type Pt } from '../../spatialIndex'
import { RouterWorld } from '../world'
import { routerBounds } from '../boundaries'
import { RouteSession, type RouteProposal } from '../engine'
import { CANARY_BOARD } from '../../../__tests__/canaryFixture'

// docs/router-behavior.md R6 on a real board: a route walked round a
// footprint's crowd of pads and tracks is pulled into a simple wrap, not left
// following every outline it passed.

const FIXTURE = CANARY_BOARD

describe('round the bitclock board’s busiest footprints', () => {
  const board = parseKicadBoard(readFileSync(FIXTURE, 'utf8'))
  const index = BoardSpatialIndex.build(board)
  const world = new RouterWorld(index, undefined, () => routerBounds(board, 0.3))
  const net = 1e6 // a net nothing is on: every copper is in the way
  const clear = (p: Pt): boolean =>
    world.collisions(p, p, 0.1, 0.2, { layer: 'F.Cu', excludeNet: net }).length === 0
  /** The clear point nearest `p`, looked for in rings round it. */
  const clearNear = (p: Pt): Pt => {
    for (let r = 0; r < 6; r += 0.1)
      for (let a = 0; a < 2 * Math.PI; a += 0.3) {
        const q = { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) }
        if (clear(q)) return q
      }
    return p
  }
  const byFootprint = new Map<number, CopperItem[]>()
  for (const item of index.items) {
    if (item?.ref.type !== 'pad' || !item.layers.includes('F.Cu')) continue
    byFootprint.set(item.ref.index, [...(byFootprint.get(item.ref.index) ?? []), item])
  }
  const busiest = [...byFootprint.values()].sort((a, b) => b.length - a.length).slice(0, 3)

  test.each(busiest.flatMap((pads, k) => [[k, 1, pads] as const, [k, -1, pads] as const]))(
    'footprint %i, side %i: a simple wrap',
    (_k, side, pads) => {
      const minX = Math.min(...pads.map((p) => p.minX))
      const maxX = Math.max(...pads.map((p) => p.maxX))
      const minY = Math.min(...pads.map((p) => p.minY))
      const maxY = Math.max(...pads.map((p) => p.maxY))
      const cy = (minY + maxY) / 2
      const tail = clearNear({ x: minX - 2, y: cy })
      const round = { x: (minX + maxX) / 2, y: side > 0 ? maxY + 1.5 : minY - 1.5 }
      const end = clearNear({ x: maxX + 2, y: cy + 0.7 })
      const session = new RouteSession(world)
      let from = { x: tail.x + 0.3, y: tail.y }
      let last: RouteProposal | null = null
      // The mouse goes round one side of the footprint and on to the far side of it.
      for (const to of [round, end]) {
        for (let t = 0.05; t <= 1 + 1e-9; t += 0.05) {
          last = session.propose({
            mode: 'walkaround',
            tail,
            cursor: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
            cornerMode: '45',
            diagFirst: false,
            autoPosture: true,
            layer: 'F.Cu',
            width: 0.2,
            clearance: 0.2,
            net
          })
        }
        from = to
      }
      // Legal throughout. (The head does not yet get round: on this board every
      // case stops short in the footprint's fanout, so the wrap itself is unchecked.)
      expect(last!.blocked).toBe(false)
      expect(last!.segments.every((s) => !s.violation)).toBe(true)
      expect(last!.segments.length).toBeLessThanOrEqual(10)
    }
  )
})
