import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { BoardSpatialIndex } from '../spatialIndex'
import {
  computeConnectivity,
  dragAirwires,
  draggedRefPredicate,
  startDragRatsnest,
  translateAirwires,
  type BoardConnectivity
} from '../boardConnectivity'

// Minimal 2-layer board wrapper; world space is y-up (KiCad y negated).
const boardWith = (body: string): string => `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
${body}
)`

const fp = (name: string, x: number, y: number, net: number, layer = 'F.Cu'): string =>
  `(footprint "Test:FP" (layer "${layer}") (uuid "${name}") (at ${x} ${y})
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "${layer}") (net ${net} "GND")))`

const connectivity = (body: string): BoardConnectivity => {
  const board = parseKicadBoard(boardWith(body))
  return computeConnectivity(board, BoardSpatialIndex.build(board))
}

describe('clusters', () => {
  test('two apart pads on one net are two clusters with one airwire', () => {
    const conn = connectivity(`${fp('a', 0, 0, 1)}\n${fp('b', 10, 0, 1)}`)
    const net = conn.nets.get(1)!
    expect(net.clusterCount).toBe(2)
    expect(net.airwires).toHaveLength(1)
    expect(conn.unrouted).toBe(1)
    const wire = net.airwires[0]
    const xs = [wire.from.x, wire.to.x].sort((a, b) => a - b)
    expect(xs).toEqual([0, 10])
    expect(wire.from.y).toBe(0)
  })

  test('a segment landing on both pad centers joins them', () => {
    const conn = connectivity(
      `${fp('a', 0, 0, 1)}\n${fp('b', 10, 0, 1)}
      (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))`
    )
    expect(conn.nets.get(1)!.clusterCount).toBe(1)
    expect(conn.airwires).toHaveLength(0)
    expect(conn.unrouted).toBe(0)
  })

  test('a track ending mid-segment on another same-net track connects (T junction)', () => {
    const conn = connectivity(
      `(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
      (segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "s2"))`
    )
    expect(conn.nets.get(1)!.clusterCount).toBe(1)
  })

  test('different nets never merge, and net 0 copper is ignored', () => {
    const conn = connectivity(
      `(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
      (segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net 2) (uuid "s2"))
      (segment (start 20 0) (end 30 0) (width 0.25) (layer "F.Cu") (net 0) (uuid "s3"))`
    )
    expect(conn.nets.get(1)!.clusterCount).toBe(1)
    expect(conn.nets.get(2)!.clusterCount).toBe(1)
    expect(conn.nets.has(0)).toBe(false)
    expect(conn.unrouted).toBe(0)
  })

  test('coincident copper on different layers is apart until a via spans them', () => {
    const tracks = `(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
      (segment (start 10 0) (end 20 0) (width 0.25) (layer "B.Cu") (net 1) (uuid "s2"))`
    expect(connectivity(tracks).nets.get(1)!.clusterCount).toBe(2)

    const withVia = `${tracks}
      (via (at 10 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))`
    expect(connectivity(withVia).nets.get(1)!.clusterCount).toBe(1)
  })
})

describe('zones', () => {
  const fillSquare = `(zone (net 1) (net_name "GND") (layers "F.Cu") (uuid "z1") (hatch edge 0.5)
    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
    (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))`

  test('a fill joins the same-net pads inside it', () => {
    const conn = connectivity(`${fp('a', 2, 2, 1)}\n${fp('b', 8, 8, 1)}\n${fillSquare}`)
    expect(conn.nets.get(1)!.clusterCount).toBe(1)
    expect(conn.airwires).toHaveLength(0)
  })

  test('a fill does not join a foreign-net pad or another layer', () => {
    const conn = connectivity(`${fp('a', 2, 2, 2)}\n${fp('b', 8, 8, 1, 'B.Cu')}\n${fillSquare}`)
    expect(conn.nets.get(2)!.clusterCount).toBe(1)
    // The B.Cu pad and the F.Cu fill stay apart; the fill is then a lone
    // kept island, absent from the ratsnest, so the pad stands alone.
    expect(conn.nets.get(1)!.clusterCount).toBe(1)
    expect(conn.nets.get(1)!.airwires).toHaveLength(0)
  })

  test('a lone kept zone island is absent from the ratsnest (KiCad parity)', () => {
    // The fill engine keeps such islands deliberately; KiCad does not draw
    // an airwire to them, and neither do we.
    const conn = connectivity(`${fp('a', 20, 0, 1)}\n${fillSquare}`)
    const net = conn.nets.get(1)!
    expect(net.clusterCount).toBe(1)
    expect(net.airwires).toHaveLength(0)
    expect(conn.unrouted).toBe(0)
  })

  test('a cluster of zone copper alone is not in the ratsnest, as in KiCad', () => {
    // Two overlapping fills join into one cluster no pad reaches: nothing on it
    // needs connecting (isolated copper is its own rule), so no airwire.
    const twoFills = `(zone (net 1) (net_name "GND") (layers "F.Cu") (uuid "z1") (hatch edge 0.5)
      (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
      (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 6 0) (xy 6 10) (xy 0 10)))
      (filled_polygon (layer "F.Cu") (pts (xy 4 0) (xy 10 0) (xy 10 10) (xy 4 10))))`
    const net = connectivity(`${fp('a', 20, 0, 1)}\n${twoFills}`).nets.get(1)!
    expect(net.clusterCount).toBe(1)
    expect(net.airwires).toEqual([])
    expect(net.islands.map((i) => i.orphaned)).toEqual([true, true])
  })

  test('islands sharing a vertex join, as KiCad counts a boundary point as inside', () => {
    const touching = `(zone (net 1) (net_name "GND") (layers "F.Cu") (uuid "z1") (hatch edge 0.5)
      (polygon (pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 0 10)))
      (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
      (filled_polygon (layer "F.Cu") (pts (xy 10 10) (xy 12 11) (xy 11 12))))`
    const islands = connectivity(`${fp('a', 2, 2, 1)}\n${touching}`).nets.get(1)!.islands
    expect(islands.map((i) => i.orphaned)).toEqual([false, false])
    expect(islands.map((i) => i.connections)).toEqual([2, 1])
  })

  test('an island no pad reaches is orphaned, through tracks or not', () => {
    const two = `(zone (net 1) (net_name "GND") (layers "F.Cu") (uuid "z1") (hatch edge 0.5)
      (polygon (pts (xy 0 0) (xy 40 0) (xy 40 10) (xy 0 10)))
      (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
      (filled_polygon (layer "F.Cu") (pts (xy 30 0) (xy 40 0) (xy 40 10) (xy 30 10))))`
    const track = `(segment (start 35 5) (end 50 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))`
    const islands = connectivity(`${fp('a', 2, 2, 1)}\n${two}\n${track}`).nets.get(1)!.islands
    expect(islands.map((i) => [i.polyIndex, i.orphaned])).toEqual([
      [0, false],
      [1, true]
    ])
  })

  test('a via marked to drop unused layers joins a zone only where its list allows', () => {
    const via = (list: string): string =>
      `(via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (remove_unused_layers yes) ${list} (net 1) (uuid "v1"))`
    const pad = fp('b', 20, 5, 1, 'B.Cu')
    const backTrack = `(segment (start 5 5) (end 20 5) (width 0.25) (layer "B.Cu") (net 1) (uuid "t1"))`
    const board = (list: string): string =>
      `${fp('a', 2, 2, 1)}\n${fillSquare}\n${via(list)}\n${backTrack}\n${pad}`
    expect(connectivity(board('(zone_layer_connections "F.Cu")')).nets.get(1)!.clusterCount).toBe(1)
    expect(connectivity(board('(zone_layer_connections)')).nets.get(1)!.clusterCount).toBe(2)
  })

  test('an unfilled zone connects nothing', () => {
    const outlineOnly = `(zone (net 1) (net_name "GND") (layers "F.Cu") (uuid "z1") (hatch edge 0.5)
      (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))`
    const conn = connectivity(`${fp('a', 2, 2, 1)}\n${fp('b', 8, 8, 1)}\n${outlineOnly}`)
    expect(conn.nets.get(1)!.clusterCount).toBe(2)
  })
})

describe('airwires', () => {
  test('spanning wires join near neighbors, not the long diagonal', () => {
    // 1 mm pads: 12 sits 2 mm clear of 10 (1 mm apart they would touch).
    const conn = connectivity(`${fp('a', 0, 0, 1)}\n${fp('b', 10, 0, 1)}\n${fp('c', 12, 0, 1)}`)
    const net = conn.nets.get(1)!
    expect(net.airwires).toHaveLength(2)
    const lengths = net.airwires
      .map((w) => Math.hypot(w.to.x - w.from.x, w.to.y - w.from.y))
      .sort((a, b) => a - b)
    expect(lengths[0]).toBeCloseTo(2)
    expect(lengths[1]).toBeCloseTo(10)
  })

  test('airwires span in world space (KiCad y negated)', () => {
    const conn = connectivity(`${fp('a', 0, 5, 1)}\n${fp('b', 10, 5, 1)}`)
    const wire = conn.nets.get(1)!.airwires[0]
    expect(wire.from.y).toBe(-5)
    expect(wire.to.y).toBe(-5)
  })
})

describe('scoped recompute', () => {
  test('a nets filter computes only those nets', () => {
    const body = `${fp('a', 0, 0, 1)}\n${fp('b', 10, 0, 1)}\n${fp('c', 0, 5, 2)}\n${fp(
      'd',
      10,
      5,
      2
    )}`
    const board = parseKicadBoard(boardWith(body))
    const index = BoardSpatialIndex.build(board)
    const conn = computeConnectivity(board, index, new Set([1]))
    expect(conn.nets.has(1)).toBe(true)
    expect(conn.nets.has(2)).toBe(false)
    expect(conn.unrouted).toBe(1)
  })
})

// A full 2-layer KiCad 8 board, routed and poured in KiCad — the parity
// canary: KiCad's own connectivity reads it as (nearly) fully connected, so
// ours must too. Sibling fixture may be absent in isolated checkouts.
import { readFileSync } from 'node:fs'
import { CANARY_BOARD } from '../../__tests__/canaryFixture'

const FIXTURE = CANARY_BOARD

describe('a real KiCad-routed board reads as connected', () => {
  test('every routed net is one cluster; airwires only where KiCad shows them', () => {
    const board = parseKicadBoard(readFileSync(FIXTURE, 'utf8'))
    const index = BoardSpatialIndex.build(board)
    const conn = computeConnectivity(board, index)
    expect(conn.nets.size).toBeGreaterThan(10)
    // KiCad reads this board as fully routed; parity demands we do too.
    expect(conn.unrouted).toBe(0)
  })
})

describe('dynamic-drag helpers', () => {
  const wire = (net: number): Parameters<typeof translateAirwires>[0][number] => ({
    net,
    from: { x: 0, y: 0 },
    to: { x: 10, y: 0 },
    fromRef: { type: 'pad', index: 3, pad: 1 },
    toRef: { type: 'via', index: 7 }
  })

  test('a selected footprint claims its pads; other refs match by identity', () => {
    const dragged = draggedRefPredicate([
      { type: 'footprint', index: 3 },
      { type: 'segment', index: 2 }
    ])
    expect(dragged({ type: 'pad', index: 3, pad: 1 })).toBe(true)
    expect(dragged({ type: 'pad', index: 4, pad: 1 })).toBe(false)
    expect(dragged({ type: 'segment', index: 2 })).toBe(true)
    expect(dragged({ type: 'via', index: 7 })).toBe(false)
    expect(dragged({ type: 'zone', index: 3 })).toBe(false)
  })

  test('translation moves only endpoints riding the drag', () => {
    const dragged = draggedRefPredicate([{ type: 'footprint', index: 3 }])
    const [moved] = translateAirwires([wire(1)], dragged, 2, -1)
    expect(moved.from).toEqual({ x: 2, y: -1 })
    expect(moved.to).toEqual({ x: 10, y: 0 })
    // Untouched wires come back as the same object (cheap per-frame path).
    const untouched = wire(1)
    const otherDrag = draggedRefPredicate([{ type: 'zone', index: 0 }])
    expect(translateAirwires([untouched], otherDrag, 2, -1)[0]).toBe(untouched)
  })
})

describe('the drag ratsnest', () => {
  const routed = boardWith(`${fp('a', 0, 0, 1)}\n${fp('b', 10, 0, 1)}\n${fp('c', 20, 0, 2)}
    (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))`)
  const start = (
    body: string,
    dragged: Array<{ type: string; index: number }>
  ): ReturnType<typeof startDragRatsnest> => {
    const board = parseKicadBoard(body)
    return startDragRatsnest(board, BoardSpatialIndex.build(board), draggedRefPredicate(dragged))
  }

  test('a dragged part comes off its track: its net gets an airwire', () => {
    const drag = start(routed, [{ type: 'footprint', index: 0 }])
    expect([...drag.nets]).toEqual([1])
    const wires = dragAirwires(drag, 0, 3)
    expect(wires).toHaveLength(1)
    // The pad's end rides the drag.
    expect(wires[0].from).toEqual({ x: 0, y: 3 })
  })

  test('copper dragged together stays connected', () => {
    const drag = start(routed, [
      { type: 'footprint', index: 0 },
      { type: 'footprint', index: 1 },
      { type: 'segment', index: 0 }
    ])
    expect(dragAirwires(drag, 5, 5)).toEqual([])
  })

  test('the wire re-picks the nearest copper of its net as the drag goes', () => {
    const body = boardWith(`${fp('a', 0, 0, 1)}\n${fp('b', -10, 0, 1)}\n${fp('c', 10, 0, 1)}
      (segment (start -10 0) (end -10 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
      (segment (start 10 0) (end 10 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "s2"))`)
    const drag = start(body, [{ type: 'footprint', index: 0 }])
    const ends = (dx: number): number[] =>
      dragAirwires(drag, dx, 0)
        .filter((w) => w.from.x === dx || w.to.x === dx)
        .map((w) => (w.from.x === dx ? w.to.x : w.from.x))
    // Past b, the dragged pad's one wire lands on b; past c, on c.
    expect(ends(-14)).toEqual([-10])
    expect(ends(14)).toEqual([10])
    // Between them it joins both, shorter than b and c's own 20 mm wire.
    expect(ends(-6).sort((a, b) => a - b)).toEqual([-10, 10])
    expect(dragAirwires(drag, 14, 0)).toHaveLength(2)
  })
})
