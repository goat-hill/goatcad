import { describe, expect, it } from 'vitest'
import { parseKicadFootprint, serializeKicadFootprint } from '../../kicad/footprint'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  flipLayer,
  hasPadstack,
  mirrorPoint,
  moveFootprintAnchor,
  normalizeAngle,
  rotatePoint,
  transformFootprintItems,
  transformPivot,
  type FootprintTransform,
  type ItemRef
} from '../footprintTransform'

const FP = `(footprint "T"
  (version 20260206)
  (generator "pcbnew")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15)) (justify left)))
  (fp_line (start 1 0) (end 2 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_arc (start 1 0) (mid 0 -1) (end -1 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_rect (start 1 1) (end 3 2) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
  (fp_circle (center 0 0) (end 1 0) (stroke (width 0.1) (type solid)) (fill none) (layer "B.CrtYd"))
  (fp_poly (pts (xy 0 0) (xy 2 0) (xy 2 2)) (stroke (width 0.1) (type solid)) (fill solid) (layer "F.SilkS"))
  (pad "1" smd roundrect (at 2 1 90) (size 1 1.5) (layers "F.Cu" "F.Paste" "F.Mask")
    (roundrect_rratio 0.25) (chamfer_ratio 0.2) (chamfer top_left bottom_left))
  (pad "2" thru_hole circle (at -2 0) (size 1.6 1.6) (drill 0.8 (offset 0.1 0.2)) (layers "*.Cu" "*.Mask"))
  (pad "3" smd custom (at 0 3) (size 0.5 0.5) (layers "F.Cu" "F.Mask")
    (primitives (gr_arc (start 1 0) (mid 0 -1) (end -1 0) (width 0.1))
      (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0) (fill yes))))
  (zone (net 0) (net_name "") (layers "F.Cu") (hatch edge 0.5)
    (polygon (pts (xy 0 0) (xy 4 0) (xy 4 4))))
  (model "x.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
`

const fp = (): ReturnType<typeof parseKicadFootprint> => parseKicadFootprint(FP)
/** Apply a transform about its pivot, then re-read the file as KiCad would. */
const apply = (
  refs: ItemRef[],
  t: FootprintTransform,
  snap?: (p: { x: number; y: number }) => { x: number; y: number }
): ReturnType<typeof parseKicadFootprint> => {
  const model = fp()
  transformFootprintItems(model, refs, t, transformPivot(model, refs, t, snap))
  return parseKicadFootprint(serializeKicadFootprint(model))
}

describe('point and layer math', () => {
  it('turns counter-clockwise as drawn, y down', () => {
    expect(rotatePoint({ x: mm(1), y: 0 }, { x: 0, y: 0 }, 90)).toEqual({ x: 0, y: mm(-1) })
    expect(rotatePoint({ x: mm(1), y: 0 }, { x: 0, y: 0 }, -90)).toEqual({ x: 0, y: mm(1) })
    expect(rotatePoint({ x: mm(3), y: mm(1) }, { x: mm(1), y: mm(1) }, 180)).toEqual({
      x: mm(-1),
      y: mm(1)
    })
  })

  it('mirrors across either axis through the pivot', () => {
    expect(mirrorPoint({ x: mm(3), y: mm(1) }, { x: mm(1), y: 0 }, 'leftRight')).toEqual({
      x: mm(-1),
      y: mm(1)
    })
    expect(mirrorPoint({ x: mm(3), y: mm(1) }, { x: 0, y: mm(2) }, 'topBottom')).toEqual({
      x: mm(3),
      y: mm(3)
    })
  })

  it('folds angles into [0, 360)', () => {
    expect(normalizeAngle(-90)).toBe(270)
    expect(normalizeAngle(450)).toBe(90)
    expect(normalizeAngle(360)).toBe(0)
    expect(normalizeAngle(89.99999999)).toBe(90)
  })

  it('swaps only sided layers', () => {
    expect(flipLayer('F.SilkS')).toBe('B.SilkS')
    expect(flipLayer('B.Cu')).toBe('F.Cu')
    expect(flipLayer('*.Cu')).toBe('*.Cu')
    expect(flipLayer('F&B.Cu')).toBe('F&B.Cu')
    expect(flipLayer('User.1')).toBe('User.1')
  })
})

describe('transformPivot', () => {
  it('is a lone item’s position, or a rectangle’s center when it turns', () => {
    const model = fp()
    expect(
      transformPivot(model, [{ type: 'pad', index: 0 }], { kind: 'rotate', angle: 90 })
    ).toEqual({ x: mm(2), y: mm(1) })
    expect(
      transformPivot(model, [{ type: 'rect', index: 0 }], { kind: 'rotate', angle: 90 })
    ).toEqual({ x: mm(2), y: mm(1.5) })
    expect(
      transformPivot(model, [{ type: 'rect', index: 0 }], {
        kind: 'mirror',
        direction: 'leftRight'
      })
    ).toEqual({ x: mm(1), y: mm(1) })
  })

  it('is the snapped center of a selection, text left out', () => {
    const model = fp()
    const refs = [
      { type: 'line', index: 0 },
      { type: 'property', index: 0 }
    ]
    const pivot = transformPivot(model, refs, { kind: 'rotate', angle: 90 }, (p) => ({
      x: Math.round(p.x / mm(1)) * mm(1),
      y: Math.round(p.y / mm(1)) * mm(1)
    }))
    // The line spans x 1..2 (plus half its stroke) at y 0; the reference is ignored.
    expect(pivot).toEqual({ x: mm(2), y: 0 })
  })

  it('flips about the anchor unless one item flips alone', () => {
    const model = fp()
    expect(transformPivot(model, [{ type: 'pad', index: 0 }], { kind: 'flip' })).toEqual({
      x: mm(2),
      y: mm(1)
    })
    expect(transformPivot(model, [{ type: 'rect', index: 0 }], { kind: 'flip' })).toEqual({
      x: 0,
      y: 0
    })
    expect(
      transformPivot(
        model,
        [
          { type: 'pad', index: 0 },
          { type: 'pad', index: 1 }
        ],
        { kind: 'flip' }
      )
    ).toEqual({ x: 0, y: 0 })
  })
})

describe('rotate', () => {
  it('turns pads about the pivot and adds to their angle', () => {
    const out = apply(
      [
        { type: 'pad', index: 0 },
        { type: 'pad', index: 1 }
      ],
      { kind: 'rotate', angle: 90 },
      (p) => ({ x: Math.round(p.x / mm(1)) * mm(1), y: Math.round(p.y / mm(1)) * mm(1) })
    )
    // Pads span x -2.8..2.75, y -0.8..1.5: the center snaps to (0, 0).
    expect(out.pads[0].position).toEqual({ x: mm(1), y: mm(-2), angle: 180 })
    expect(out.pads[1].position).toEqual({ x: 0, y: mm(2), angle: 90 })
  })

  it('drops a pad angle that comes back to zero, as KiCad writes it', () => {
    const out = apply([{ type: 'pad', index: 0 }], { kind: 'rotate', angle: -90 })
    expect(out.pads[0].position).toEqual({ x: mm(2), y: mm(1) })
    expect(serializeKicadFootprint(out)).toContain('(at 2 1)')
  })

  it('keeps a rectangle a normalized rectangle turned about its center', () => {
    const out = apply([{ type: 'rect', index: 0 }], { kind: 'rotate', angle: 90 })
    expect(out.fpRects[0].start).toEqual({ x: mm(1.5), y: mm(0.5) })
    expect(out.fpRects[0].end).toEqual({ x: mm(2.5), y: mm(2.5) })
  })

  it('turns text and keeps a written zero angle', () => {
    const out = apply([{ type: 'property', index: 0 }], { kind: 'rotate', angle: 90 })
    expect(out.properties[0].position).toEqual({ x: 0, y: mm(-2), angle: 90 })
    const back = parseKicadFootprint(serializeKicadFootprint(out))
    transformFootprintItems(
      back,
      [{ type: 'property', index: 0 }],
      { kind: 'rotate', angle: -90 },
      {
        x: 0,
        y: mm(-2)
      }
    )
    expect(serializeKicadFootprint(back)).toContain('(at 0 -2 0)')
  })
})

describe('mirror', () => {
  it('negates a pad’s angle and mirrors its own frame', () => {
    const out = apply(
      [
        { type: 'pad', index: 0 },
        { type: 'pad', index: 1 },
        { type: 'pad', index: 2 }
      ],
      { kind: 'mirror', direction: 'leftRight' },
      () => ({ x: 0, y: 0 })
    )
    expect(out.pads[0].position).toEqual({ x: mm(-2), y: mm(1), angle: 270 })
    expect(out.pads[0].chamfer).toEqual(['top_right', 'bottom_right'])
    expect(out.pads[0].layers).toEqual(['F.Cu', 'F.Paste', 'F.Mask'])
    expect(out.pads[1].drill?.offset).toEqual({ x: mm(-0.1), y: mm(0.2) })
    const arc = out.pads[2].primitives!.arcs[0]
    // Mirrored, then its ends swapped: the same arc, still drawn start → end.
    expect(arc.start).toEqual({ x: mm(1), y: 0 })
    expect(arc.end).toEqual({ x: mm(-1), y: 0 })
    expect(arc.mid).toEqual({ x: 0, y: mm(-1) })
    expect(out.pads[2].primitives!.polys[0].points[2]).toEqual({ x: mm(-1), y: mm(1) })
  })

  it('swaps an arc’s ends and a horizontal text’s justification', () => {
    const out = apply(
      [
        { type: 'arc', index: 0 },
        { type: 'property', index: 0 }
      ],
      { kind: 'mirror', direction: 'topBottom' },
      () => ({ x: 0, y: 0 })
    )
    expect(out.fpArcs[0].start).toEqual({ x: mm(-1), y: 0 })
    expect(out.fpArcs[0].mid).toEqual({ x: 0, y: mm(1) })
    expect(out.fpArcs[0].end).toEqual({ x: mm(1), y: 0 })
    expect(out.properties[0].position).toEqual({ x: 0, y: mm(2), angle: 0 })
    // Top-bottom only swaps a vertical text's justification.
    expect(out.properties[0].fontEffects?.hAlign).toBe('left')
    const lr = apply([{ type: 'property', index: 0 }], { kind: 'mirror', direction: 'leftRight' })
    expect(lr.properties[0].fontEffects?.hAlign).toBe('right')
    expect(lr.properties[0].fontEffects?.mirror).toBeFalsy()
  })
})

describe('flip', () => {
  it('mirrors left-right about the anchor and swaps sides', () => {
    const refs = [
      { type: 'pad', index: 0 },
      { type: 'line', index: 0 },
      { type: 'circle', index: 0 },
      { type: 'property', index: 0 },
      { type: 'zone', index: 0 }
    ]
    const out = apply(refs, { kind: 'flip' })
    expect(out.pads[0].position).toEqual({ x: mm(-2), y: mm(1), angle: 270 })
    expect(out.pads[0].layers).toEqual(['B.Cu', 'B.Paste', 'B.Mask'])
    expect(out.fpLines[0].start).toEqual({ x: mm(-1), y: 0 })
    expect(out.fpLines[0].layer).toBe('B.SilkS')
    expect(out.fpCircles[0].layer).toBe('F.CrtYd')
    expect(out.properties[0].layer).toBe('B.SilkS')
    expect(out.properties[0].fontEffects?.mirror).toBe(true)
    expect(out.zones[0].layers).toEqual(['B.Cu'])
    expect(out.zones[0].points[1]).toEqual({ x: mm(-4), y: 0 })
  })

  it('leaves a through-hole pad on every copper layer', () => {
    const out = apply([{ type: 'pad', index: 1 }], { kind: 'flip' })
    expect(out.pads[1].layers).toEqual(['*.Cu', '*.Mask'])
    expect(out.pads[1].position).toEqual({ x: mm(-2), y: 0 })
  })

  it('knows a pad with a padstack', () => {
    const model = parseKicadFootprint(
      FP.replace(
        '(layers "*.Cu" "*.Mask"))',
        '(layers "*.Cu" "*.Mask") (padstack (mode front_inner_back)))'
      )
    )
    expect(hasPadstack(model.pads[1])).toBe(true)
    expect(hasPadstack(model.pads[0])).toBe(false)
  })
})

describe('moveFootprintAnchor', () => {
  it('shifts every item by the opposite offset and carries the model with it', () => {
    const model = fp()
    moveFootprintAnchor(model, { x: mm(1), y: mm(2) })
    const out = parseKicadFootprint(serializeKicadFootprint(model))
    expect(out.pads[0].position).toEqual({ x: mm(1), y: mm(-1), angle: 90 })
    expect(out.fpLines[0].start).toEqual({ x: 0, y: mm(-2) })
    expect(out.fpPolys[0].points[0]).toEqual({ x: mm(-1), y: mm(-2) })
    expect(out.properties[0].position).toEqual({ x: mm(-1), y: mm(-4), angle: 0 })
    expect(out.zones[0].points[0]).toEqual({ x: mm(-1), y: mm(-2) })
    expect(out.model?.offset).toEqual({ x: mm(-1), y: mm(2), z: 0 })
    // Custom-pad primitives sit in the pad's frame and stay.
    expect(out.pads[2].primitives!.arcs[0].start).toEqual({ x: mm(1), y: 0 })
  })

  it('is a no-op at the current anchor', () => {
    const model = fp()
    moveFootprintAnchor(model, { x: 0, y: 0 })
    expect(serializeKicadFootprint(model)).toBe(serializeKicadFootprint(fp()))
  })
})
