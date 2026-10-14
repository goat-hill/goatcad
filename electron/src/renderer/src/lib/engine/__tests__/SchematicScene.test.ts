import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import {
  dnpDimmedColor,
  sameSchematicRef,
  schematicItemKey,
  LIFT_SPLIT_Z,
  SchematicScene,
  SCHEMATIC_PAINT_ORDER
} from '../SchematicScene'
import { parseKicadSchematic } from '../../kicad/schematic'
import { allowsKindFor, resolveHit } from '../../selectionResolve'

const source = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root")
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_0_1"
        (rectangle (start -1 -2) (end 1 2)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3 270) (length 1)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
  )
  (symbol (lib_id "Device:R") (at 50 50 0) (unit 1)
    (uuid "sym")
    (property "Reference" "R1" (at 52 49 0) (effects (font (size 1.27 1.27)) hide)))
  (wire (pts (xy 10 10) (xy 20 10))
    (stroke (width 0) (type default)) (uuid "w"))
)`

describe('SchematicScene selection halo over part-keyed paint', () => {
  // Symbol strokes are filed under part names (`symbol:0/pin:…`) so a single
  // pin can be moved. The glow journal keys the same way, so a selection asking
  // for `symbol:0` has to gather its parts — getting that wrong makes the halo
  // silently disappear, which no rendering test would have caught.
  //
  // The fixture's Reference is HIDDEN deliberately. When this was written,
  // field text journalled under the symbol's OWN key, so a visible field would
  // have produced a halo whether or not parts were gathered — and the test
  // would have passed while the body and pins went unhaloed. Step 5 gave fields
  // their own part key, so that hole is closed either way; the fixture stays
  // hidden because it costs nothing and keeps the assertion about parts alone.
  const build = (): { scene: SchematicScene; three: THREE.Scene } => {
    const three = new THREE.Scene()
    const scene = new SchematicScene(three)
    scene.rebuild(parseKicadSchematic(source))
    return { scene, three }
  }

  const glowInstances = (three: THREE.Scene): number => {
    // The glow batch is one instanced mesh; count the instances it is drawing.
    const meshes = three.children.filter(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh
    )
    return meshes.reduce(
      (total, mesh) =>
        total + ((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount || 0),
      0
    )
  }

  test('selecting a symbol draws a halo, though its paint is filed under parts', () => {
    const { scene, three } = build()
    const before = glowInstances(three)
    scene.setSelection([{ type: 'symbol', index: 0 }])
    expect(glowInstances(three)).toBeGreaterThan(before)
  })

  test('deselecting clears it again', () => {
    const { scene, three } = build()
    scene.setSelection([{ type: 'symbol', index: 0 }])
    const selected = glowInstances(three)
    scene.setSelection([])
    expect(glowInstances(three)).toBeLessThan(selected)
  })

  test('a wire — a key with no parts — still haloes', () => {
    const { scene, three } = build()
    const before = glowInstances(three)
    scene.setSelection([{ type: 'wire', index: 0 }])
    expect(glowInstances(three)).toBeGreaterThan(before)
  })
})

// hitTest is now the first entry of hitCandidates resolved against the editor's
// policy (lib/selectionResolve.ts). The ranking itself must not have shifted in
// that refactor: it is this scene's own rule — small items before symbol
// bodies, sheets last — and reconciling it with the board's distance-then-z
// rule would be a behavior change, not plumbing.
describe('SchematicScene hit candidates', () => {
  const mount = (): SchematicScene => {
    const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
    scene.rebuild(parseKicadSchematic(source))
    return scene
  }

  test('reports what is under the cursor, and hitTest takes the first of it', () => {
    const scene = mount()
    // On the wire run from (10,10) to (20,10); the scene draws y negated.
    const point = new THREE.Vector2(15, -10)
    const candidates = scene.hitCandidates(point, 0.5)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].levels[0].ref).toEqual({ type: 'wire', index: 0 })
    expect(scene.hitTest(point, 0.5)).toEqual({ type: 'wire', index: 0 })
  })

  test('finds nothing in empty space, and hitTest agrees', () => {
    const scene = mount()
    const point = new THREE.Vector2(500, 500)
    expect(scene.hitCandidates(point, 0.5)).toEqual([])
    expect(scene.hitTest(point, 0.5)).toBeNull()
  })

  test('offers a wire once however many of its segments are in reach', () => {
    const scene = mount()
    // Near the run's corner-free middle: one candidate, not one per segment.
    const candidates = scene.hitCandidates(new THREE.Vector2(15, -10), 5)
    const wires = candidates.filter((c) => c.levels[0].ref.type === 'wire')
    expect(wires).toHaveLength(1)
  })

  test('ranks the symbol body after smaller items, as hitTest always did', () => {
    const scene = mount()
    // A generous threshold at the symbol reaches its body and the pin's run.
    const candidates = scene.hitCandidates(new THREE.Vector2(50, -50), 4)
    const kinds = candidates.map((c) => c.levels[0].kind)
    if (kinds.includes('symbol') && kinds.length > 1) {
      expect(kinds.indexOf('symbol')).toBe(kinds.length - 1)
    }
    expect(scene.hitTest(new THREE.Vector2(50, -50), 4)).toEqual(candidates[0].levels[0].ref)
  })
})

// Field text is the ONE thing inside a schematic symbol a click can land on:
// moving a Reference off a crowded body is an ordinary thing to do, while a pin
// is named for highlighting and netlist sync but resolves up to its symbol.
// See ARCHITECTURE.md §3.7.
const withVisibleReference = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root")
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_0_1"
        (rectangle (start -1 -2) (end 1 2)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3 270) (length 1)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
  )
  (symbol (lib_id "Device:R") (at 50 50 0) (unit 1)
    (uuid "sym")
    (property "Reference" "R1" (at 56 44 0) (effects (font (size 1.27 1.27)))))
)`

describe('SchematicScene field justification through the symbol', () => {
  // A field stored at 90, `justify right`, on every turn and mirror of its
  // symbol, and which way from its anchor `kicad-cli sch export svg` (KiCad
  // 10) runs the text: the stored justification reads in the symbol's frame.
  const CASES: Array<[number, '' | 'x' | 'y', 'right' | 'left' | 'up' | 'down']> = [
    [0, '', 'down'],
    [0, 'x', 'up'],
    [0, 'y', 'down'],
    [90, '', 'right'],
    [90, 'x', 'right'],
    [90, 'y', 'left'],
    [180, '', 'up'],
    [180, 'x', 'down'],
    [180, 'y', 'up'],
    [270, '', 'left'],
    [270, 'x', 'left'],
    [270, 'y', 'right']
  ]
  const STEP = { right: [1.5, 0], left: [-1.5, 0], up: [0, -1.5], down: [0, 1.5] } as const
  const OPPOSITE = { right: 'left', left: 'right', up: 'down', down: 'up' } as const

  const fieldHitsAt = (scene: SchematicScene, x: number, y: number): boolean =>
    scene
      .hitCandidates(new THREE.Vector2(x, -y), 0.1)
      .some((candidate) => candidate.levels[0].kind === 'field')

  test.each(CASES)('a symbol at %i mirror "%s" runs it %s', (angle, mirror, way) => {
    const source = withVisibleReference
      .replace('(at 50 50 0)', `(at 50 50 ${angle})${mirror ? ` (mirror ${mirror})` : ''}`)
      .replace(
        '(at 56 44 0) (effects (font (size 1.27 1.27))))',
        '(at 56 44 90) (effects (font (size 1.27 1.27)) (justify right)))'
      )
    const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
    scene.rebuild(parseKicadSchematic(source))
    const [dx, dy] = STEP[way]
    const [ox, oy] = STEP[OPPOSITE[way]]
    expect(fieldHitsAt(scene, 56 + dx, 44 + dy)).toBe(true)
    expect(fieldHitsAt(scene, 56 + ox, 44 + oy)).toBe(false)
  })
})

describe('SchematicScene field selection', () => {
  const mount = (): SchematicScene => {
    const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
    scene.rebuild(parseKicadSchematic(withVisibleReference))
    return scene
  }

  /** Glow instances currently drawn, however many batches carry them. */
  const haloSize = (three: THREE.Scene): number =>
    three.children
      .filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
      .reduce(
        (total, mesh) =>
          total + ((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount || 0),
        0
      )

  /** The candidate whose most specific level is a field, if the click found one. */
  const fieldCandidateAt = (
    scene: SchematicScene,
    point: THREE.Vector2
  ): ReturnType<SchematicScene['hitCandidates']>[number] | undefined =>
    scene.hitCandidates(point, 0.6).find((c) => c.levels[0].kind === 'field')

  test('a click on field text reports the field AND the symbol under it', () => {
    const scene = mount()
    // The Reference sits at (56, 44); the scene draws y negated.
    const candidate = fieldCandidateAt(scene, new THREE.Vector2(56, -44))
    expect(candidate).toBeDefined()
    expect(candidate!.levels.map((l) => l.kind)).toEqual(['field', 'symbol'])
    expect(candidate!.levels[0].ref).toEqual({ type: 'field', index: 0, field: 'Reference' })
    expect(candidate!.levels[1].ref).toEqual({ type: 'symbol', index: 0 })
  })

  // The whole point of reporting both levels: an editor that does not allow
  // fields resolves the same click up to the symbol rather than losing it.
  test('the same click resolves to the field or the symbol, by policy', () => {
    const scene = mount()
    const candidates = scene.hitCandidates(new THREE.Vector2(56, -44), 0.6)
    expect(resolveHit(candidates, allowsKindFor('schematic'))).toEqual({
      type: 'field',
      index: 0,
      field: 'Reference'
    })
    const noFields = ({ kind }: { kind: string }): boolean => kind !== 'field'
    expect(resolveHit(candidates, noFields)).toEqual({ type: 'symbol', index: 0 })
  })

  test('a field carries a drag pivot, having no anchor object to resolve through', () => {
    const scene = mount()
    const pivot = scene.fieldPivot({ type: 'field', index: 0, field: 'Reference' })
    expect(pivot).toEqual({ x: 56, y: -44 })
    expect(scene.fieldPivot({ type: 'field', index: 0, field: 'Nonexistent' })).toBeNull()
  })

  // Fields are filed UNDER the symbol, so dragging the symbol still carries its
  // text. Keying them as a document-level item would have broken symbol drag.
  test('selecting the symbol still haloes its field text', () => {
    const three = new THREE.Scene()
    const scene = new SchematicScene(three)
    scene.rebuild(parseKicadSchematic(withVisibleReference))
    const bare = haloSize(three)

    scene.setSelection([{ type: 'symbol', index: 0 }])
    const withSymbol = haloSize(three) - bare
    expect(withSymbol).toBeGreaterThan(0)

    scene.setSelection([{ type: 'field', index: 0, field: 'Reference' }])
    const fieldOnly = haloSize(three) - bare
    // The symbol's halo covers its body, its pin AND its field; the field's
    // covers only the text — so filing fields under the symbol kept symbol
    // selection whole while making the field reachable on its own.
    expect(fieldOnly).toBeGreaterThan(0)
    expect(fieldOnly).toBeLessThan(withSymbol)
  })

  test('a rubber band takes the symbol, never its field', () => {
    const scene = mount()
    const swept = scene.boxSelect({ xMin: 0, xMax: 200, yMin: -200, yMax: 0 }, true)
    expect(swept.some((item) => item.type === 'symbol')).toBe(true)
    expect(swept.some((item) => item.type === 'field')).toBe(false)
  })
})

// Two fields of ONE symbol share `type` and `index` — Reference and Value are
// both `field:0` — so identity has to come off the key. Comparing the pair
// would call them the same thing, and shift-clicking the second would deselect
// the first instead of adding it.
describe('schematic ref identity', () => {
  const reference = { type: 'field' as const, index: 0, field: 'Reference' }
  const value = { type: 'field' as const, index: 0, field: 'Value' }

  test('tells two fields of one symbol apart', () => {
    expect(sameSchematicRef(reference, reference)).toBe(true)
    expect(sameSchematicRef(reference, value)).toBe(false)
    // The pair they collide on, spelled out so the reason stays visible.
    expect(reference.type === value.type && reference.index === value.index).toBe(true)
  })

  test('separates a field from the symbol that owns it', () => {
    expect(sameSchematicRef(reference, { type: 'symbol', index: 0 })).toBe(false)
  })

  test('still compares document items by kind and index', () => {
    expect(sameSchematicRef({ type: 'wire', index: 2 }, { type: 'wire', index: 2 })).toBe(true)
    expect(sameSchematicRef({ type: 'wire', index: 2 }, { type: 'wire', index: 3 })).toBe(false)
    expect(sameSchematicRef({ type: 'wire', index: 2 }, { type: 'label', index: 2 })).toBe(false)
  })

  test('keys a field under its symbol, so the symbol still carries it', () => {
    expect(schematicItemKey(reference)).toBe('symbol:0/field:Reference')
    expect(schematicItemKey({ type: 'symbol', index: 0 })).toBe('symbol:0')
  })
})

describe('symbol graphic fills', () => {
  // KiCad fills symbol bodies (11.6k background-filled rectangles across the 222
  // standard libraries), and the shapes with no analytic form — polylines,
  // beziers, arcs — are triangulated into meshes rather than drawn by the
  // primitive batch. These assert the RULES, which were measured against KiCad
  // 10 via `kicad-cli sym export svg` and are the kind of thing a later change
  // could silently invert.
  const sceneWith = (graphic: string): THREE.Scene => {
    const three = new THREE.Scene()
    const scene = new SchematicScene(three)
    scene.rebuild(
      parseKicadSchematic(`(kicad_sch
        (version 20231120) (generator "t") (uuid "r")
        (lib_symbols (symbol "L:S" (symbol "S_0_1" ${graphic})))
        (symbol (lib_id "L:S") (at 0 0 0) (unit 1) (uuid "s"))
      )`)
    )
    return three
  }
  /** Triangulated fills are Meshes; batch geometry is not. */
  const fillMeshes = (three: THREE.Scene): THREE.Mesh[] => {
    const found: THREE.Mesh[] = []
    three.traverse((o) => {
      if (o instanceof THREE.Mesh && o.geometry.getIndex() && o.geometry.getAttribute('position')) {
        // The batch's own mesh is a single instanced quad; a fill carries one
        // vertex per contour point.
        if (!(o.geometry instanceof THREE.InstancedBufferGeometry)) found.push(o)
      }
    })
    return found
  }

  test('fills an unclosed polyline as the polygon its points enclose', () => {
    // Probed: KiCad emits the fill as an UNCLOSED SVG path with `fill:#FFFFC2`,
    // which fills by implicit closure. So three points make a filled triangle.
    const filled = fillMeshes(
      sceneWith(
        `(polyline (pts (xy -10 0) (xy 0 10) (xy 10 0))
          (stroke (width 0.254) (type default)) (fill (type background)))`
      )
    )
    expect(filled).toHaveLength(1)
    expect(filled[0].geometry.getAttribute('position').count).toBe(3)
  })

  test('draws no fill mesh when the polyline is unfilled', () => {
    expect(
      fillMeshes(
        sceneWith(
          `(polyline (pts (xy -10 0) (xy 0 10) (xy 10 0))
            (stroke (width 0.254) (type default)) (fill (type none)))`
        )
      )
    ).toHaveLength(0)
  })

  test('closes a filled arc through the circle CENTER, not its chord', () => {
    // The finding this test exists for. A semicircle cannot distinguish the two
    // (its chord runs through its center), so the fixture is a SHALLOW arc:
    // start/end at y=0, center far below at y≈-15.17. The fill must reach it.
    const filled = fillMeshes(
      sceneWith(
        `(arc (start -10 0) (mid 0 3) (end 10 0)
          (stroke (width 0.254) (type default)) (fill (type background)))`
      )
    )
    expect(filled).toHaveLength(1)
    const position = filled[0].geometry.getAttribute('position')
    let lowest = Infinity
    for (let i = 0; i < position.count; i++) lowest = Math.min(lowest, position.getY(i))
    // Scene space flips Y, so the circle center is the point FARTHEST from the
    // arc — a chord-closed fill would stop at 0 and never reach ~15.17.
    expect(Math.abs(lowest)).toBeGreaterThan(14)
  })

  test('leaves rectangles to the batch rather than triangulating them', () => {
    // An analytic shape costs one SDF instance and drags for free; only the
    // shapes with no analytic form pay for a mesh.
    expect(
      fillMeshes(
        sceneWith(
          `(rectangle (start -1 -2) (end 1 2)
            (stroke (width 0.254) (type default)) (fill (type background)))`
        )
      )
    ).toHaveLength(0)
  })
})

describe('KiCad-measured pin and field rules', () => {
  // Audited against the `ecc83-pp` demo library in KiCad 10, with the constants
  // read from KiCad's source rather than eyeballed. Each is a rule the renderer
  // had wrong, so each is worth pinning.
  // Fields live on the PLACED instance, which is what `addSymbol` reads and what
  // `buildSymbolPreviewSchematic` copies the library's onto in the real editor.
  const LIB = `(symbol "L:S"
      (pin_names (offset 0))
      (symbol "S_1_1"
        (pin power_in line (at 0 0 270) (length 0) (hide yes)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))`
  const PLACED = `(symbol (lib_id "L:S") (at 0 0 0) (unit 1) (uuid "s")
      (property "Reference" "#PWR" (at 0 -6.35 0)
        (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "Lib:FP" (at 0 -1 0) (effects (font (size 0.762 0.762)))))`

  const build = (editor: boolean): SchematicScene => {
    const scene = new SchematicScene(new THREE.Scene())
    if (editor) scene.setSymbolEditorMode(true)
    scene.rebuild(
      parseKicadSchematic(`(kicad_sch
        (version 20231120) (generator "t") (uuid "r")
        (lib_symbols ${LIB})
        ${PLACED}
      )`)
    )
    return scene
  }
  const drew = (scene: SchematicScene, field: string): boolean =>
    scene.fieldPivot({ type: 'symbol', index: 0, field }) !== null

  test('the symbol editor draws every field, including hidden ones', () => {
    // `CONN_1` in the demo is the case that surfaced this: its Footprint is
    // visible and its Value is `(hide yes)`, and KiCad's symbol editor draws
    // BOTH — the hidden one greyed — because you cannot position or unhide a
    // field you cannot see. We drew neither.
    const scene = build(true)
    expect(drew(scene, 'Footprint')).toBe(true)
    expect(drew(scene, 'Reference')).toBe(true) // hidden, but shown here
  })

  test('a placed symbol draws its visible fields and not its hidden ones', () => {
    // The schematic's rule, and why showing hidden fields is a switch rather
    // than the default: a hidden Reference must not appear on the sheet unasked.
    // A visible Footprint is drawn, as KiCad draws it.
    const scene = build(false)
    expect(drew(scene, 'Reference')).toBe(false)
    expect(drew(scene, 'Footprint')).toBe(true)
    expect(drew(scene, 'Value')).toBe(true)
  })
})

describe('symbol editor hidden-item switches', () => {
  // One visible pin, one hidden pin somewhere else, and a stack of two at a
  // third point — the three cases the switches and the badge have to separate.
  const LIB = `(symbol "L:S"
      (symbol "S_1_1"
        (pin passive line (at -5 0 0) (length 2)
          (name "IN" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin power_in line (at 0 5 270) (length 2) (hide yes)
          (name "VCC" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 5 0 180) (length 2)
          (name "OUT" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 5 0 180) (length 2) (hide yes)
          (name "OUT" (effects (font (size 1.27 1.27))))
          (number "4" (effects (font (size 1.27 1.27)))))))`
  const PLACED = `(symbol (lib_id "L:S") (at 0 0 0) (unit 1) (uuid "s")
      (property "Reference" "U1" (at 0 -8 0) (effects (font (size 1.27 1.27))))
      (property "Datasheet" "https://x" (at 0 -10 0)
        (effects (font (size 1.27 1.27)) (hide yes))))`

  const build = (editor: boolean, display?: { pins: boolean; fields: boolean }): SchematicScene => {
    const scene = new SchematicScene(new THREE.Scene())
    if (editor) scene.setSymbolEditorMode(true)
    if (display) scene.setHiddenDisplay(display)
    scene.rebuild(
      parseKicadSchematic(`(kicad_sch
        (version 20231120) (generator "t") (uuid "r")
        (lib_symbols ${LIB})
        ${PLACED}
      )`)
    )
    return scene
  }

  const keys = (scene: SchematicScene): string[] => [...scene.debugElements().keys()]
  // The connection ring is filed under `<pin key>:conn`, so the pin lines are
  // what is left after dropping it.
  const pinKeys = (scene: SchematicScene): string[] =>
    keys(scene).filter((key) => key.includes('/pin:') && !key.endsWith(':conn'))
  const drewField = (scene: SchematicScene, field: string): boolean =>
    scene.fieldPivot({ type: 'symbol', index: 0, field }) !== null

  test('both switches default on: the editor draws the whole symbol', () => {
    const scene = build(true)
    // Three points carry pins, and the stacked pair shares one key prefix, so
    // the count is what separates "drew the hidden one" from "skipped it".
    expect(pinKeys(scene).length).toBe(4)
    expect(drewField(scene, 'Datasheet')).toBe(true)
  })

  test('switching hidden pins off leaves the visible ones alone', () => {
    const scene = build(true, { pins: false, fields: true })
    expect(pinKeys(scene).length).toBe(2)
    // The switch is about pins; a hidden field is a separate decision.
    expect(drewField(scene, 'Datasheet')).toBe(true)
  })

  test('switching hidden fields off leaves the visible ones alone', () => {
    const scene = build(true, { pins: true, fields: false })
    expect(drewField(scene, 'Datasheet')).toBe(false)
    expect(drewField(scene, 'Reference')).toBe(true)
    expect(pinKeys(scene).length).toBe(4)
  })

  test('a sheet shows no hidden item until its switches say so', () => {
    const scene = build(false)
    expect(pinKeys(scene).length).toBe(2)
    expect(drewField(scene, 'Datasheet')).toBe(false)
    expect(drewField(scene, 'Reference')).toBe(true)
  })

  test("a sheet's switches show hidden pins and hidden fields, each on its own", () => {
    const pins = build(false, { pins: true, fields: false })
    expect(pinKeys(pins).length).toBe(4)
    expect(drewField(pins, 'Datasheet')).toBe(false)
    const fields = build(false, { pins: false, fields: true })
    expect(pinKeys(fields).length).toBe(2)
    expect(drewField(fields, 'Datasheet')).toBe(true)
  })
})

// The stack is KiCad's, and getting it wrong is invisible until two things
// happen to overlap on a real sheet — a no-connect landing on the pin it marks
// was drawn UNDER that pin's line for exactly that reason. Pinning the order
// here means the next layer added has to state where it belongs.
describe('schematic paint order', () => {
  const Z = SCHEMATIC_PAINT_ORDER

  test("runs bottom-to-top in KiCad's SCH_LAYER_ORDER", () => {
    // `eeschema/sch_view.h`, read from its LAST entry back to its first.
    const stack = [
      Z.symbolFill, // LAYER_DEVICE_BACKGROUND
      Z.sheetFrame, // LAYER_SHEET
      Z.symbolStroke, // LAYER_DEVICE — body outlines and pin lines
      Z.dnpMarker, // drawn in the device pass, one AdvanceDepth() up
      Z.wire, // LAYER_WIRE
      Z.notes, // LAYER_NOTES
      Z.labelArrow, // LAYER_{LOC,GLOB,HIER}LABEL
      Z.noConnect, // LAYER_NOCONNECT
      Z.junction, // LAYER_JUNCTION
      Z.text, // LAYER_PINNAM / LAYER_PINNUM
      Z.fieldText, // LAYER_FIELDS / VALUEPART / REFERENCEPART
      Z.dangling, // LAYER_DANGLING
      Z.preview // LAYER_GP_OVERLAY
    ]
    expect(stack).toEqual([...stack].sort((a, b) => a - b))
    expect(new Set(stack).size).toBe(stack.length)
  })

  test("the editor's ghosted paint sits one tier under the class it mirrors", () => {
    expect(Z.hiddenStroke).toBeLessThan(Z.symbolStroke)
    expect(Z.hiddenConnection).toBeLessThan(Z.pinConnection)
    expect(Z.hiddenText).toBeLessThan(Z.text)
    // …and still above the fill, or a hidden pin inside a filled body would be
    // off screen entirely — the one thing that rendering exists to prevent.
    expect(Z.hiddenStroke).toBeGreaterThan(Z.symbolFill)
  })

  test('a selected item clears every static tier', () => {
    expect(Z.selectedLift).toBeGreaterThan(Z.preview)
  })
})

describe('a selected fill', () => {
  const Z = SCHEMATIC_PAINT_ORDER
  const FILLED = `(kicad_sch (version 20250114) (generator "t") (uuid "u") (paper "A4") (lib_symbols)
  (rectangle (start 40 40) (end 50 50) (stroke (width 0) (type default)) (fill (type color) (color 40 40 40 1)) (uuid "r1")))`
  // Instance rows are `data0(4),data1(4),color(4)`; z is data1's third slot.
  const zOf = (row: string): number => Number(row.split(',')[6])
  const redOf = (row: string): number => Number(row.split(',')[8])
  const blueOf = (row: string): number => Number(row.split(',')[10])
  const rows = (scene: SchematicScene, key: string): string[] =>
    scene.debugElements().get(key) ?? []

  test('lands above every static tier but under the halo, its strokes over it', () => {
    for (const fill of [Z.notesFill, Z.symbolFill]) {
      expect(fill + Z.selectedFillLift).toBeGreaterThan(Z.preview)
      expect(fill + Z.selectedFillLift).toBeLessThan(LIFT_SPLIT_Z)
    }
    const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
    scene.rebuild(parseKicadSchematic(FILLED))
    const [fillBefore] = rows(scene, 'shape:0:fill')
    scene.setSelectedElementKeys(['shape:0'])
    const [fill] = rows(scene, 'shape:0:fill')
    expect(zOf(fill)).toBeGreaterThan(Z.preview)
    expect(zOf(fill)).toBeLessThan(LIFT_SPLIT_Z)
    for (const row of rows(scene, 'shape:0')) expect(zOf(row)).toBeGreaterThan(LIFT_SPLIT_Z)
    // Tinted toward the selection blue, so the body takes its halo's hue.
    expect(blueOf(fill)).toBeGreaterThan(blueOf(fillBefore))
    expect(redOf(fill)).not.toBe(redOf(fillBefore))
    scene.setSelectedElementKeys([])
    const [restored] = rows(scene, 'shape:0:fill')
    expect(zOf(restored)).toBeCloseTo(zOf(fillBefore), 6)
    expect(redOf(restored)).toBe(redOf(fillBefore))
  })
})

describe('DNP symbols', () => {
  const sheet = new THREE.Color('#101513')

  test("dnpDimmedColor desaturates, then meets the page halfway — KiCad's two steps", () => {
    const symbolColor = new THREE.Color('#cca250')
    const dim = dnpDimmedColor(symbolColor, sheet)

    const before = { h: 0, s: 0, l: 0 }
    const after = { h: 0, s: 0, l: 0 }
    symbolColor.getHSL(before)
    dim.getHSL(after)
    // The hue is gone: what is left is the page's own tint, not the symbol's.
    expect(after.s).toBeLessThan(before.s / 2)
    // And it has moved toward the page, which halving the saturation alone
    // would not do.
    const distance = (color: THREE.Color): number =>
      Math.hypot(color.r - sheet.r, color.g - sheet.g, color.b - sheet.b)
    expect(distance(dim)).toBeLessThan(distance(symbolColor))
  })

  const withDnp = (dnp: boolean): SchematicScene => {
    const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
    scene.rebuild(
      parseKicadSchematic(source.replace('(unit 1)', `(unit 1)${dnp ? ' (dnp yes)' : ''}`))
    )
    return scene
  }
  // Instance rows are `data0(4),data1(4),color(4)`; z is data1's third slot.
  const zOf = (row: string): number => Number(row.split(',')[6])
  const rgbOf = (row: string): number[] => row.split(',').slice(8, 11).map(Number)

  test('a DNP instance is struck through; a populated one is not', () => {
    const marked = withDnp(true).debugElements().get('symbol:0') ?? []
    expect(marked).toHaveLength(2)
    for (const row of marked) expect(zOf(row)).toBeCloseTo(SCHEMATIC_PAINT_ORDER.dnpMarker, 6)

    // Sized KiCad's way, worked through for this fixture. The body is the
    // 2 x 4 mm rectangle; the one pin runs from y 3 down to the body edge at
    // y 2, so it overhangs by 1 mm vertically and by nothing horizontally.
    // The margins then fall out as x = max(0 x 0.6, 1 x 0.3) = 0.3 and
    // y = max(1 x 0.6, 0.3 x 0.3) = 0.6 — each axis borrowing from the other,
    // which is what keeps the cross square-ish on a tall, narrow part. The
    // symbol sits at (50, 50), which the scene draws y-negated.
    const corners = marked.map((row) => row.split(',').slice(0, 4).map(Number))
    for (const [x0, y0, x1, y1] of corners) {
      expect(Math.min(x0, x1)).toBeCloseTo(50 - 1 - 0.3, 4)
      expect(Math.max(x0, x1)).toBeCloseTo(50 + 1 + 0.3, 4)
      expect(Math.min(y0, y1)).toBeCloseTo(-50 - 2 - 0.6, 4)
      expect(Math.max(y0, y1)).toBeCloseTo(-50 + 2 + 0.6, 4)
    }
    // Two diagonals, not one drawn twice.
    expect(corners[0][1]).not.toBeCloseTo(corners[1][1], 4)
    expect(withDnp(false).debugElements().has('symbol:0')).toBe(false)
  })

  test('and every stroke of it is dimmed, body and pins alike', () => {
    const plain = withDnp(false).debugElements()
    const marked = withDnp(true).debugElements()
    const distance = (rgb: number[]): number =>
      Math.hypot(rgb[0] - sheet.r, rgb[1] - sheet.g, rgb[2] - sheet.b)

    const symbolKeys = [...plain.keys()].filter((key) => key.startsWith('symbol:'))
    expect(symbolKeys.length).toBeGreaterThan(1)
    for (const key of symbolKeys) {
      const before = plain.get(key)!
      const after = marked.get(key)!
      expect(after).toBeDefined()
      expect(distance(rgbOf(after[0]))).toBeLessThan(distance(rgbOf(before[0])))
    }
    // The wire beside it is untouched — the dim belongs to the symbol, not to
    // the rebuild.
    expect(rgbOf(marked.get('wire:0')![0])).toEqual(rgbOf(plain.get('wire:0')![0]))
  })
})
