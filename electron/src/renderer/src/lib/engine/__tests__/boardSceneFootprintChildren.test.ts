import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import { BoardScene } from '../BoardScene'
import { moveBoardFootprintInAST, parseKicadBoard } from '../../kicad/board'
import { mmToNm as mm } from '../../kicad/coordinates'

// A part whose Reference was moved well clear of its body, as after a drag.
const source = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user))
  (net 0 "")
  (footprint "R:R" (layer "F.Cu") (at 50 50) (uuid "u1")
    (property "Reference" "R1" (at 12 0 0) (layer "F.SilkS") (uuid "p1") (effects (font (size 2 2) (thickness 0.3))))
    (pad "1" smd rect (at -1.5 0) (size 1.2 1.8) (layers "F.Cu") (uuid "a1"))
    (pad "2" smd rect (at 1.5 0) (size 1.2 1.8) (layers "F.Cu") (uuid "a2")))
)`

// BoardScene rasterizes glyphs against a DOM canvas; this environment has none.
beforeEach(() => {
  const fakeCtx = {
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    measureText: (text: string) => ({ width: text.length * 20 + 8 }),
    fillText: (): void => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4)
    })
  }
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx })
  })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
})

/** What a click at board (x, y) mm lands on first, as `type` or `type:child`. */
const pick = (scene: BoardScene, x: number, y: number): string | undefined => {
  const ref = scene.hitCandidates(new THREE.Vector2(x, -y), 0.2)[0]?.levels[0]?.ref
  return ref && (ref.child === undefined ? ref.type : `${ref.type}:${ref.child}`)
}

describe('a footprint’s children on the board', () => {
  test('a field moved clear of its part is hit across its glyphs, not only at its anchor', () => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source))
    expect(pick(scene, 62, 50)).toBe('fp_field:0') // its anchor
    expect(pick(scene, 63.2, 50)).toBe('fp_field:0') // the "1", well past the anchor
  })

  test('and still after its footprint moves', () => {
    const board = parseKicadBoard(source)
    moveBoardFootprintInAST(board.footprints[0], mm(60), mm(50))
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(board)
    expect(pick(scene, 73.2, 50)).toBe('fp_field:0')
    expect(pick(scene, 63.2, 50)).not.toBe('fp_field:0')
  })

  test('a pad the click is just off wins over its own footprint', () => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source))
    // 0.1 mm right of pad 1's edge, inside the part's box.
    expect(pick(scene, 49.2, 50)).toBe('pad')
  })
})

describe("a footprint's zones on the board", () => {
  // A keep-out the part carries, board-absolute as the file holds it, clear of its body.
  const withKeepout = source.replace(
    '(pad "1"',
    `(zone (net 0) (net_name "") (layers "F.Cu") (uuid "kz") (hatch edge 0.5)
      (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
      (polygon (pts (xy 44 40) (xy 56 40) (xy 56 42) (xy 44 42))))
    (pad "1"`
  )
  const outline = (text: string): number =>
    [...scene(text).debugSnapshot().batch]
      .filter(([key]) => key.endsWith('|footprint:0'))
      .reduce((sum, [, rows]) => sum + rows.length, 0)
  const scene = (text: string): BoardScene => {
    const built = new BoardScene(new THREE.Scene())
    built.rebuild(parseKicadBoard(text))
    return built
  }

  test('are drawn with the footprint: an outline edge per side, under its key', () => {
    expect(outline(withKeepout) - outline(source)).toBe(4)
  })

  test('select the footprint, which their outline widens as KiCad’s box does', () => {
    expect(pick(scene(source), 50, 40)).toBeUndefined()
    expect(pick(scene(withKeepout), 50, 40)).toBe('footprint')
  })

  test('move with it', () => {
    const board = parseKicadBoard(withKeepout)
    moveBoardFootprintInAST(board.footprints[0], mm(60), mm(50))
    const moved = new BoardScene(new THREE.Scene())
    moved.rebuild(board)
    expect(pick(moved, 60, 40)).toBe('footprint')
    expect(pick(moved, 46, 40)).toBeUndefined()
  })
})

describe('a footprint in a move', () => {
  test('grabs by its origin or a pad, and is a snap target only while it is not moving', () => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source))
    const points = (vs: THREE.Vector2[]): number[][] => vs.map((v) => [v.x, v.y])
    const footprint = [{ type: 'footprint', index: 0 }]
    expect(points(scene.moveAnchors(footprint))).toEqual([
      [50, -50],
      [48.5, -50],
      [51.5, -50]
    ])
    expect(points(scene.snapTargets([]))).toEqual(points(scene.moveAnchors(footprint)))
    expect(scene.snapTargets(footprint)).toEqual([])
  })
})
