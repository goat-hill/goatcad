import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import { BoardScene } from '../BoardScene'
import { parseKicadBoard } from '../../kicad/board'
import {
  LIFTED_SLOT_OFFSET,
  LayerStack,
  NETNAMES_PSEUDO_LAYER,
  PCB_LAYER_STACK,
  VIA_PSEUDO_LAYER,
  layerSlot,
  DIM_ALPHA_FACTOR
} from '../../kicad/layers'
import { PaintOrder } from '../../kicad/paintOrder'
import { META, copperBit, copperMask } from '../boardView'
import { LayeredLabelBatch } from '../LayeredBatch'
import { loadClipper } from '../../geometry/clip'
import { HATCH_PATTERN } from '../HatchShader'

/**
 * Where the board puts via copper, pad and via labels, and mask openings — the
 * slot each lands in (`slot|key` in the debug snapshot), since the slot is
 * what decides what covers what.
 */

const board = (body: string, copper = '(0 "F.Cu" signal) (31 "B.Cu" signal)'): string => `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers ${copper} (37 "F.Mask" user) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  ${body}
)`

const pad = (net: number, name: string): string => `(footprint "T:P"
    (layer "F.Cu")
    (at 5 5)
    (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net ${net} "${name}")
      (solder_mask_margin 0.1)))`

const via = '(via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v0"))'

// BoardScene rasterizes glyphs against a DOM canvas; this environment has none.
let cssVars: Record<string, string> = {}
beforeEach(() => {
  cssVars = {}
  const fakeCtx = {
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    measureText: (s: string) => ({ width: s.length * 20 + 8 }),
    fillText: (): void => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4)
    })
  }
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx })
  })
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => cssVars[name] ?? ''
  }))
})

/**
 * The labels a rebuild asks for — key, slot and ink. The stubbed canvas yields
 * no glyphs, so the snapshot cannot show them; the call can.
 */
interface LabelCall {
  key: string
  slot: number
  ink: string
  /** The meta the label is written with (`boardView.ts`): net word, span, dark-ink faces, own-pad faces. */
  meta: number[]
}

const labelCalls = (source: string, activeLayer?: string): LabelCall[] => {
  const calls: LabelCall[] = []
  const spy = vi.spyOn(LayeredLabelBatch.prototype, 'addLabelBlock').mockImplementation(function (
    this: LayeredLabelBatch,
    key: string,
    _lines,
    _x,
    _y,
    z: number
  ) {
    const ink = (this as unknown as { ink: { color: THREE.Color | null } }).ink.color
    calls.push({
      key,
      slot: layerSlot(z),
      ink: ink ? `#${new THREE.Color(ink).getHexString()}` : '',
      meta: [...this.writeMeta]
    })
  })
  const scene = new BoardScene(new THREE.Scene())
  scene.rebuild(parseKicadBoard(source), undefined, activeLayer)
  spy.mockRestore()
  return calls
}

const snapshot = (
  source: string,
  visibility?: Record<string, boolean>
): ReturnType<BoardScene['debugSnapshot']> => {
  const scene = new BoardScene(new THREE.Scene())
  scene.rebuild(parseKicadBoard(source), visibility)
  return scene.debugSnapshot()
}

const slots = new LayerStack()
const at = (layer: string): string => `${slots.slotOf(layer)}|`

/** The slots a key has paint in. */
const slotsOf = (entries: Map<string, string[]>, key: string): string[] =>
  [...entries.keys()].filter((k) => k.endsWith(`|${key}`)).map((k) => k.split('|').at(-2)!)

describe('via copper', () => {
  test('is drawn on every copper layer the via passes through, in that layer', () => {
    const { batch } = snapshot(
      board(via, '(0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal)')
    )
    const drawn = slotsOf(batch, 'via:0')
    for (const layer of ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', VIA_PSEUDO_LAYER]) {
      expect(drawn).toContain(String(slots.slotOf(layer)))
    }
  })

  test('shows while only an inner layer it passes through is visible', () => {
    const { batch } = snapshot(
      board(via, '(0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal)'),
      { 'F.Cu': false, 'B.Cu': false }
    )
    expect(slotsOf(batch, 'via:0')).toContain(String(slots.slotOf('In1.Cu')))
  })
})

describe('labels', () => {
  const netnames = slots.slotOf(NETNAMES_PSEUDO_LAYER)

  test("a pad's label is in its copper's label lane, which paints above vias and holes while that copper faces", () => {
    const [label] = labelCalls(board(pad(1, 'GND'))).filter((c) => c.key.includes('pad:0'))
    expect(label.slot).toBe(slots.slotOf('F.Cu'))
    const paint = new PaintOrder()
    expect(paint.renderOrder(label.slot, 'label')).toBeGreaterThan(
      paint.renderOrder(slots.slotOf(VIA_PSEUDO_LAYER), 'stroke')
    )
  })

  test("a back pad's label stays under the front copper", () => {
    const back = `(footprint "T:P" (layer "B.Cu") (at 5 5)
      (pad "1" smd circle (at 0 0) (size 1 1) (layers "B.Cu") (net 1 "GND")))`
    const [label] = labelCalls(board(back)).filter((c) => c.key.includes('pad:0'))
    expect(label.slot).toBe(slots.slotOf('B.Cu'))
  })

  /** The faces on which a via's label is hidden, sitting in a pad of its own net there. */
  const ownPadFaces = (calls: LabelCall[]): number => {
    const label = calls.find((c) => c.key === 'via:0')!
    expect(label.meta[0] >>> 24).toBe(META.SPAN | META.INK_BY_FACING | META.OWN_PAD)
    return label.meta[3]
  }

  test('a via in a pad of its own net is not labelled where that pad faces; the pad names the net', () => {
    const copper = '(0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal)'
    const faces = ownPadFaces(labelCalls(board(`${pad(1, 'GND')} ${via}`, copper)))
    expect(faces & copperBit('F.Cu')).not.toBe(0)
    // Seen from a layer the pad is not on, the via is labelled after all.
    expect(faces & copperBit('In1.Cu')).toBe(0)
  })

  test('a via in a pad of another net keeps its label — that is a short', () => {
    const calls = labelCalls(board(`${pad(2, 'VCC')} ${via}`))
    expect(calls.find((c) => c.key === 'via:0')?.slot).toBe(netnames)
    expect(ownPadFaces(calls)).toBe(0)
  })

  test("a drilled pad's label reads on its hole as well as its copper", () => {
    // In2.Cu's copper alone takes dark ink; a mounting hole's label also sits
    // on the dark bore, where only light ink reads (KiCad's H11 on Jetson).
    const copper = '(0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal)'
    const smd = `(footprint "T:S" (layer "F.Cu") (at 5 5)
      (pad "1" smd circle (at 0 0) (size 6.5 6.5) (layers "In2.Cu") (net 1 "GND")))`
    const pth = `(footprint "T:H" (layer "F.Cu") (at 5 5)
      (pad "1" thru_hole circle (at 0 0) (size 6.5 6.5) (drill 3.7) (layers "*.Cu") (net 1 "GND")))`
    const smdLabel = labelCalls(board(smd, copper)).find((c) => c.key.includes('pad:0'))
    expect(smdLabel?.ink).toBe('#121a16')
    // On several copper layers it is drawn in both inks, the dark one shown
    // only where the facing copper wants it — and on In2.Cu the bore does not.
    const pthLabels = labelCalls(board(pth, copper)).filter((c) => c.key.includes('pad:0'))
    expect(pthLabels.map((c) => c.ink).sort()).toEqual(['#121a16', '#eef3f0'])
    expect(pthLabels[0].meta[2] & copperBit('In2.Cu')).toBe(0)
  })

  test('take the ink that reads on what is under them', () => {
    // A via's label is drawn in both inks; its dark-ink faces say where the dark one shows.
    const darkFaces = (): number => labelCalls(board(via)).find((c) => c.key === 'via:0')!.meta[2]
    expect(darkFaces()).toBe(0)
    // A light bore (the light theme's) takes dark ink, on every face.
    cssVars['--vscode-canvas-hole'] = '#e3ebe5'
    expect(darkFaces()).toBe(copperMask(['F.Cu', 'B.Cu']))
  })
})

describe('pad mask openings', () => {
  test('are the pad grown by its mask margin, not the copper size', () => {
    const { batch } = snapshot(board(pad(1, 'GND')), { 'F.Mask': true })
    const rows = (layer: string): string[] =>
      [...batch.entries()]
        .filter(([k]) => k.startsWith(at(layer)) && k.includes('pad:0'))
        .flatMap(([, r]) => r)
    // data0 is (x, y, halfW, halfH): the mask's half-width is 0.5 + 0.1.
    const halfW = (row: string): number => Number(row.split(',')[2])
    expect(halfW(rows('F.Cu')[0])).toBeCloseTo(0.5)
    expect(halfW(rows('F.Mask')[0])).toBeCloseTo(0.6)
  })
})

describe('picking on an inner layer', () => {
  const copper = '(0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal)'
  // A front SMD part, a through via beside it, and a track on In1 under the part.
  const source = board(
    `${pad(1, 'GND')}
    (via (at 9 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v0"))
    (segment (start 4 5.4) (end 6 5.4) (width 0.3) (layer "In1.Cu") (net 2) (uuid "s0"))`,
    copper
  )

  /** What a click at (x, y) mm (board coordinates) lands on first, In1.Cu active and the others dimmed unless said. */
  const pick = (
    x: number,
    y: number,
    view: { activeLayer?: string; nonActiveDisplay?: 'show' | 'dim' } = {}
  ): string | undefined => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source))
    scene.applyView({ activeLayer: 'In1.Cu', nonActiveDisplay: 'dim', ...view })
    return scene.hitCandidates(new THREE.Vector2(x, -y), 0.2)[0]?.levels.at(-1)?.ref.type
  }

  test('a through via answers on the inner layer it passes through', () => {
    expect(pick(9, 5)).toBe('via')
  })

  test('a dimmed part is background, as KiCad has it in high contrast', () => {
    expect(pick(5, 5)).toBeUndefined()
    // It answers once something of it is on the active layer, and whenever nothing dims.
    expect(pick(5, 5, { activeLayer: 'F.Cu' })).toBe('footprint')
    expect(pick(5, 5, { nonActiveDisplay: 'show' })).toBe('footprint')
  })

  test('copper on the active layer still wins inside the part around it', () => {
    // (5, 5.4) is inside the footprint's box and on the In1 track.
    expect(pick(5, 5.4)).toBe('segment')
  })
})

describe("a footprint's box", () => {
  // A 1 mm pad and a fab outline 10 mm across round it.
  const source = board(`(footprint "T:F" (layer "F.Cu") (at 5 5)
    (fp_rect (start -5 -5) (end 5 5) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
    (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND")))`)
  const pick = (visibility: Record<string, boolean>): string | undefined => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source))
    scene.applyView({ activeLayer: 'F.Cu', layerVisibility: visibility })
    // 4 mm from the pad: inside the fab outline only.
    return scene.hitCandidates(new THREE.Vector2(9, -5), 0.2)[0]?.levels.at(-1)?.ref.type
  }

  test('is what of it shows: a hidden fab outline does not widen it', () => {
    expect(pick({ 'F.Fab': false })).toBeUndefined()
    expect(pick({ 'F.Fab': true })).toBe('footprint')
  })
})

describe('zones sharing an edge', () => {
  const copper = '(0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal)'
  const outline = '(polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))'
  // F.Cu first in the file, In2.Cu last: file order must not decide.
  const source = board(
    `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "zf") ${outline})
    (zone (net 1) (net_name "GND") (layer "In2.Cu") (uuid "zi") ${outline})`,
    copper
  )
  const pick = (active: string): number | undefined => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source), undefined, active)
    return scene.hitCandidates(new THREE.Vector2(0, -5), 0.2)[0]?.levels[0]?.ref.index
  }

  test('the one drawn on top wins the tie: the active layer, and F.Cu over inner copper', () => {
    expect(pick('F.Cu')).toBe(0)
    expect(pick('In2.Cu')).toBe(1)
  })
})

describe('a drag preview', () => {
  test('hides the selected track it stands in for, and restores it', () => {
    const source = board(
      '(segment (start 1 1) (end 4 1) (width 0.3) (layer "F.Cu") (net 1) (uuid "s0"))'
    )
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source))
    scene.highlightSelection([{ type: 'segment', index: 0 }])
    const paint = (): string[] =>
      [...scene.debugSnapshot().batch]
        .filter(([key]) => key.endsWith('|segment:0'))
        .flatMap(([, rows]) => rows)
    const selected = paint()
    expect(selected.length).toBeGreaterThan(0)

    scene.setShovePreview([{ type: 'segment', index: 0 }], [])
    expect(paint()).not.toEqual(selected)
    // Re-highlighting mid-drag keeps it hidden.
    scene.highlightSelection([{ type: 'segment', index: 0 }])
    expect(paint()).not.toEqual(selected)

    scene.setShovePreview([], [])
    expect(paint()).toEqual(selected)
  })
})

describe('zone border hatching', () => {
  const zone = (
    style: string,
    layers = '"F.Cu" "In1.Cu"'
  ): string => `(zone (net 1) (net_name "GND")
    (layers ${layers}) (uuid "z0") (hatch ${style} 0.5)
    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))`
  const copper = '(0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal)'

  /** The hatch meshes a rebuild draws: their pitch, pattern and area. */
  const hatches = (source: string): Array<{ pitch: number; pattern: number; area: number }> => {
    const root = new THREE.Scene()
    new BoardScene(root).rebuild(parseKicadBoard(source))
    const found: Array<{ pitch: number; pattern: number; area: number }> = []
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      const uniforms = (object.material as THREE.ShaderMaterial).uniforms
      if (!uniforms?.uPattern) return
      const position = object.geometry.getAttribute('position')
      const index = object.geometry.getIndex()!
      let area = 0
      for (let i = 0; i < index.count; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => index.getX(i + k))
        area +=
          Math.abs(
            (position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a)) -
              (position.getX(c) - position.getX(a)) * (position.getY(b) - position.getY(a))
          ) / 2
      }
      found.push({ pitch: uniforms.uPitch.value, pattern: uniforms.uPattern.value, area })
    })
    return found
  }

  test('full: the whole outline, lines two pitches apart, rising on every copper layer', () => {
    // KiCad slopes by the zone's first layer id, and every copper id is even:
    // `/` on F.Cu and B.Cu alike (`ZONE::HatchBorder`).
    const drawn = hatches(board(zone('full'), copper))
    expect(drawn).toHaveLength(2)
    for (const h of drawn) {
      expect(h.pitch).toBeCloseTo((0.5 * 2) / Math.SQRT2)
      expect(h.area).toBeCloseTo(100)
      expect(h.pattern).toBe(HATCH_PATTERN.HATCH)
    }
  })

  test('edge: a band one pitch deep inside the border', async () => {
    await loadClipper()
    const [h] = hatches(board(zone('edge', '"F.Cu"'), copper))
    expect(h.pitch).toBeCloseTo(0.5 / Math.SQRT2)
    // 10 × 10 less the 9 × 9 left one pitch in.
    expect(h.area).toBeCloseTo(100 - 81, 1)
  })

  test('none: the outline alone', () => {
    expect(hatches(board(zone('none'), copper))).toHaveLength(0)
  })
})

describe('selection draws in front', () => {
  const back = `(footprint "T:P" (layer "B.Cu") (at 5 5)
      (pad "1" smd circle (at 0 0) (size 1 1) (layers "B.Cu") (net 1 "GND")))`
  const front = '(segment (start 0 5) (end 10 5) (width 0.5) (layer "F.Cu") (net 2) (uuid "s0"))'
  const top = PCB_LAYER_STACK.length - 1

  test('a selected back-side part moves above every document slot, front copper included', () => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(board(`${back} ${front}`)))
    const home = slotsOf(scene.debugSnapshot().batch, 'footprint:0/pad:0').map(Number)
    expect(home.length).toBeGreaterThan(0)
    expect(home.every((slot) => slot <= top)).toBe(true)

    scene.highlightSelection([{ type: 'footprint', index: 0 }])
    const { batch } = scene.debugSnapshot()
    const lifted = slotsOf(batch, 'footprint:0/pad:0').map(Number)
    expect(lifted.sort()).toEqual(home.map((slot) => slot + LIFTED_SLOT_OFFSET).sort())
    expect(Math.min(...lifted)).toBeGreaterThan(slots.slotOf('F.Cu'))
    expect(slotsOf(batch, 'segment:0').map(Number)).toEqual([slots.slotOf('F.Cu')])

    scene.highlightSelection([])
    expect(slotsOf(scene.debugSnapshot().batch, 'footprint:0/pad:0').map(Number).sort()).toEqual(
      home.sort()
    )
  })
})

describe('net focus in dim mode', () => {
  // F.Cu active: the routed net (1) and another (2) on B.Cu, and the other on F.Cu.
  const source =
    board(`(segment (start 0 0) (end 4 0) (width 0.25) (layer "B.Cu") (net 1) (uuid "s0"))
    (segment (start 0 2) (end 4 2) (width 0.25) (layer "B.Cu") (net 2) (uuid "s1"))
    (segment (start 0 4) (end 4 4) (width 0.25) (layer "F.Cu") (net 2) (uuid "s2"))`)
  const build = (highlightNet: number): BoardScene => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source), undefined, 'F.Cu', {
      nonActiveDisplay: 'dim',
      highlightNet
    })
    return scene
  }
  /** The net a track's paint carries to the shader (its meta's net word). */
  const netOf = (scene: BoardScene, index: number): number => {
    const [, rows] = [...scene.debugSnapshot().batch].find(([key]) =>
      key.endsWith(`segment:${index}`)
    )!
    return Number(rows[0].split(',')[12]) & 0xffffff
  }

  test('without focus, a non-active layer sinks toward the canvas; the active one does not', () => {
    const { slots } = build(0).debugView()
    expect(slots.get('B.Cu')?.uSlotDim).toBeCloseTo(DIM_ALPHA_FACTOR)
    expect(slots.get('F.Cu')?.uSlotDim).toBe(1)
  })

  test('under focus the routed net is lit on every layer, the rest sinks further off the active one', () => {
    const scene = build(1)
    // No layer dims as a layer, so the routed net's own track is not dimmed with B.Cu…
    const { shared, slots } = scene.debugView()
    expect(slots.get('B.Cu')?.uSlotDim).toBe(1)
    // …the shader is told the net, and that B.Cu is off the active layer by its dim.
    expect(shared.uFocusNet).toBe(1)
    expect(shared.uFocusInDim).toBe(1)
    expect(slots.get('B.Cu')).toMatchObject({ uSlotNonActive: 1, uSlotSurvive: DIM_ALPHA_FACTOR })
    expect(slots.get('F.Cu')).toMatchObject({ uSlotNonActive: 0 })
    expect([0, 1, 2].map((i) => netOf(scene, i))).toEqual([1, 2, 2])
  })

  test('a change of focus is applied, not built: the same paint, another uniform', () => {
    const scene = build(0)
    const before = scene.debugSnapshot().batch
    scene.applyView({ activeLayer: 'F.Cu', nonActiveDisplay: 'dim', focusNet: 1 })
    expect(scene.debugSnapshot().batch).toEqual(before)
    expect(scene.debugView().shared.uFocusNet).toBe(1)
    expect(scene.debugView().slots.get('B.Cu')?.uSlotDim).toBe(1)
  })
})

describe("dim strength, the canvas's and render.board's", () => {
  // F.Cu active: a track on B.Cu and the board outline both sit off it.
  const source =
    board(`(segment (start 0 0) (end 4 0) (width 0.25) (layer "B.Cu") (net 1) (uuid "s0"))
    (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "e0"))`)
  /** What of a layer's color its slot keeps. */
  const dimOf = (dimStrength: number | undefined, layer: string): number => {
    const scene = new BoardScene(new THREE.Scene())
    scene.rebuild(parseKicadBoard(source), undefined, 'F.Cu', {
      nonActiveDisplay: 'dim',
      ...(dimStrength === undefined ? {} : { dimStrength })
    })
    return scene.debugView().slots.get(layer)!.uSlotDim as number
  }

  test("defaults to the canvas's dim and takes the strength asked for", () => {
    expect(dimOf(undefined, 'B.Cu')).toBeCloseTo(DIM_ALPHA_FACTOR)
    expect(dimOf(0.1, 'B.Cu')).toBeCloseTo(0.1)
    expect(dimOf(1, 'B.Cu')).toBeCloseTo(1)
  })

  test('keeps the board outline at the floor the canvas gives it', () => {
    expect(dimOf(0.1, 'Edge.Cuts')).toBeCloseTo(0.3)
  })
})
