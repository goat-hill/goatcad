import { describe, expect, test } from 'vitest'
import { landPattern, range, type LandPatternInput } from '../landPattern'
import { expandPads, generateFootprint } from '../footprintGenerate'
import { footprintChecks } from '../footprintChecks'
import { DEFAULT_STYLE_CHOICES } from '../footprintStyle'
import { parseKicadFootprint } from '../../kicad/footprint'
import { nmToMm, type Nm } from '../../kicad/coordinates'

const SOIC_8_LEAD = { width: { min: 0.31, max: 0.51 }, length: { min: 0.4, max: 1.27 } }

/** JEDEC MS-012AA, as KiCad's generator data records it. */
const SOIC_8: LandPatternInput = {
  leadType: 'gullwing',
  density: 'nominal',
  body: { x: { nominal: 3.9, tolerance: 0.1 }, y: { min: 4.8, max: 5.0 } },
  span: { x: { nominal: 6, tolerance: 0.2 } },
  lead: SOIC_8_LEAD,
  pitch: 1.27,
  pins: { y: 4 }
}

const expanded = (
  input: LandPatternInput
): Array<{ number: string; x: number; y: number; w: number; h: number }> => {
  const result = landPattern(input)
  if (!result.ok) throw new Error(result.detail)
  const pads = expandPads(result.pads)
  if (!pads.ok) throw new Error(pads.detail)
  return pads.pads.map((pad) => ({
    number: pad.number,
    x: nmToMm(pad.at.x as Nm),
    y: nmToMm(pad.at.y as Nm),
    w: nmToMm(pad.size.w as Nm),
    h: nmToMm(pad.size.h as Nm)
  }))
}

describe('range', () => {
  test('reads nominal ± tolerance and min / max alike', () => {
    expect(range({ nominal: 6, tolerance: 0.2 })).toMatchObject({ min: 5.8, max: 6.2 })
    expect(range({ min: 0.4, max: 1.27 })).toMatchObject({ min: 0.4, max: 1.27 })
    expect(range({ nominal: 4 })).toMatchObject({ min: 4, max: 4, tol: 0 })
  })
})

describe('landPattern', () => {
  // Evidence the numbers are the standard's, not the test that output must
  // match KiCad's (parts-mcp §10.2): KiCad's own SOIC-8 is ±2.475, 1.95 × 0.6.
  test('a SOIC-8 lands where KiCad’s generator puts it', () => {
    const result = landPattern(SOIC_8)
    expect(result.ok && result.notes.x).toMatchObject({ Z: 6.9, G: 3, X: 0.6 })
    expect(expanded(SOIC_8).slice(0, 2)).toEqual([
      { number: '1', x: -2.475, y: -1.905, w: 1.95, h: 0.6 },
      { number: '2', x: -2.475, y: -0.635, w: 1.95, h: 0.6 }
    ])
  })

  test('numbers counter-clockwise from pin 1 at the top left', () => {
    const numbers = expanded(SOIC_8).map((pad) => `${pad.number}@${pad.x},${pad.y}`)
    expect(numbers).toEqual([
      '1@-2.475,-1.905',
      '2@-2.475,-0.635',
      '3@-2.475,0.635',
      '4@-2.475,1.905',
      '5@2.475,1.905',
      '6@2.475,0.635',
      '7@2.475,-0.635',
      '8@2.475,-1.905'
    ])
  })

  test('density moves the pads', () => {
    const most = landPattern({ ...SOIC_8, density: 'most' })
    const least = landPattern({ ...SOIC_8, density: 'least' })
    expect(most.ok && least.ok && most.notes.x!.Z > least.notes.x!.Z).toBe(true)
    expect(most.ok && most.notes.table).toMatch(/Table 3-2/)
    expect(landPattern({ ...SOIC_8, pitch: 0.5 })).toMatchObject({
      notes: { table: expect.stringMatching(/Table 3-3/) }
    })
  })

  test('a QFN goes round all four sides with the exposed pad last, clear of it', () => {
    const qfn: LandPatternInput = {
      leadType: 'no_lead',
      density: 'nominal',
      body: { x: { nominal: 4 }, y: { nominal: 4 } },
      lead: { width: { min: 0.18, max: 0.3 }, length: { min: 0.3, max: 0.5 } },
      pitch: 0.5,
      pins: { x: 5, y: 5 },
      exposedPad: { x: 2.7, y: 2.7 }
    }
    const pads = expanded(qfn)
    expect(pads.map((pad) => pad.number)).toEqual(
      Array.from({ length: 21 }, (_, i) => String(i + 1))
    )
    expect(pads[0]).toMatchObject({ x: expect.closeTo(-1.9375, 1), y: -1 })
    expect(pads[5]).toMatchObject({ x: -1, w: 0.25 })
    expect(pads[10]).toMatchObject({ y: 1 })
    expect(pads[15]).toMatchObject({ x: 1 })
    expect(pads[20]).toEqual({ number: '21', x: 0, y: 0, w: 2.7, h: 2.7 })
    const result = landPattern(qfn)
    expect(result.ok && result.notes.adjustments[0]).toMatch(/pulled back to 1.55 mm/)
    // Straight into the generator, and the checks pass.
    if (!result.ok) return
    const generated = generateFootprint(
      { name: 'QFN', attributes: 'smd', pads: result.pads, body: result.body, pin1: '1' },
      DEFAULT_STYLE_CHOICES
    )
    expect(generated.ok && footprintChecks(parseKicadFootprint(generated.text))).toEqual([])
  })

  test('a chip resistor is two pads, and close to KiCad’s 0603', () => {
    const chip: LandPatternInput = {
      leadType: 'chip',
      density: 'nominal',
      body: { x: { min: 1.5, max: 1.7 }, y: { min: 0.7, max: 0.95 } },
      lead: { length: { min: 0.15, max: 0.4 } }
    }
    const pads = expanded(chip)
    expect(pads).toHaveLength(2)
    // KiCad: ±0.825, 0.8 × 0.95.
    expect(pads[1].x).toBeCloseTo(0.825, 1)
    expect(pads[1].w).toBeCloseTo(0.8, 1)
    expect(pads[1].h).toBe(0.95)
    const small = landPattern({
      ...chip,
      body: { x: { nominal: 1 }, y: { nominal: 0.5 } },
      lead: { length: { nominal: 0.25, tolerance: 0.1 } }
    })
    expect(small.ok && small.notes.table).toMatch(/smaller than 0603/)
  })

  test('cuts a pad too wide for its pitch', () => {
    const result = landPattern({
      ...SOIC_8,
      pitch: 0.5,
      lead: { width: { min: 0.45, max: 0.55 }, length: SOIC_8_LEAD.length }
    })
    expect(result.ok && result.notes.x!.X).toBe(0.3)
    expect(result.ok && result.notes.adjustments[0]).toMatch(/cut to 0.3 mm/)
  })

  test('refuses a package it cannot compute', () => {
    expect(landPattern({ ...SOIC_8, span: undefined })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/span.x/)
    })
    expect(landPattern({ ...SOIC_8, pins: {} })).toMatchObject({ ok: false })
    expect(landPattern({ ...SOIC_8, pitch: undefined })).toMatchObject({ ok: false })
    expect(landPattern({ ...SOIC_8, lead: { length: SOIC_8_LEAD.length } })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/lead.width/)
    })
  })
})

/** JEDEC MS-001: a rectangular lead, 0.36 to 0.56 by 0.20 to 0.36. */
const DIP_8: LandPatternInput = {
  leadType: 'through_hole',
  density: 'nominal',
  body: { x: { min: 6.1, max: 7.11 }, y: { min: 9.02, max: 10.16 } },
  lead: { width: { min: 0.36, max: 0.56 }, thickness: { min: 0.2, max: 0.36 } },
  pitch: 2.54,
  pins: { y: 4 },
  rowSpacing: 7.62
}

describe('landPattern, through-hole', () => {
  test('sizes the hole over the lead’s diagonal and the land over the hole', () => {
    const result = landPattern(DIP_8)
    // √(0.56² + 0.36²) = 0.666, + 0.20 at level B, up to 0.9; + 2 × 0.05 + 0.5.
    expect(result.ok && result.notes.hole).toEqual({
      leadMax: 0.665733,
      clearance: 0.2,
      diameter: 0.9,
      land: 1.5,
      allowance: 0.5
    })
    expect(result.ok && result.notes.table).toMatch(/level B/)
    const most = landPattern({ ...DIP_8, density: 'most' })
    expect(most.ok && most.notes.hole).toMatchObject({ diameter: 0.95, land: 1.65 })
  })

  test('a round lead is its diameter', () => {
    const result = landPattern({ ...DIP_8, lead: { diameter: { nominal: 0.6, tolerance: 0.05 } } })
    expect(result.ok && result.notes.hole).toMatchObject({ leadMax: 0.65, diameter: 0.85 })
  })

  test('numbers a DIP around the part from pin 1 at the origin', () => {
    const result = landPattern(DIP_8)
    if (!result.ok) throw new Error(result.detail)
    expect(result.pads.map((pad) => [pad.number, pad.shape, pad.array?.count ?? 1])).toEqual([
      ['1', 'roundrect', 1],
      ['2', 'circle', 3],
      ['5', 'circle', 4]
    ])
    expect(result.pads[0].drill).toEqual({ diameter: 0.9 })
    expect(expanded(DIP_8).map((pad) => `${pad.number}@${pad.x},${pad.y}`)).toEqual([
      '1@0,0',
      '2@0,2.54',
      '3@0,5.08',
      '4@0,7.62',
      '5@7.62,7.62',
      '6@7.62,5.08',
      '7@7.62,2.54',
      '8@7.62,0'
    ])
    expect(result.body.rect).toEqual({ x: 0.5075, y: -0.985, width: 6.605, height: 9.59 })
    const generated = generateFootprint(
      { name: 'DIP-8', attributes: 'tht', pads: result.pads, body: result.body, pin1: '1' },
      DEFAULT_STYLE_CHOICES
    )
    expect(generated.ok && footprintChecks(parseKicadFootprint(generated.text))).toEqual([])
  })

  test('a header counts across its two columns, and one column is a row of pins', () => {
    const header: LandPatternInput = {
      ...DIP_8,
      lead: { width: { nominal: 0.64 }, thickness: { nominal: 0.64 } },
      pins: { y: 3 },
      rowSpacing: 2.54,
      numbering: 'zigzag'
    }
    expect(expanded(header).map((pad) => `${pad.number}@${pad.x},${pad.y}`)).toEqual([
      '1@0,0',
      '3@0,2.54',
      '5@0,5.08',
      '2@2.54,0',
      '4@2.54,2.54',
      '6@2.54,5.08'
    ])
    const single = expanded({ ...header, rowSpacing: undefined, numbering: undefined })
    expect(single.map((pad) => pad.number)).toEqual(['1', '2', '3'])
  })

  test('cuts a land too wide for its pitch, and says when the ring goes thin', () => {
    const result = landPattern({
      ...DIP_8,
      lead: { width: { nominal: 0.4 }, thickness: { nominal: 0.4 } },
      pitch: 1.27,
      rowSpacing: undefined
    })
    if (!result.ok) throw new Error(result.detail)
    expect(result.pads[1]).toMatchObject({ shape: 'oval', size: { width: 1.4, height: 1.07 } })
    expect(result.notes.adjustments).toHaveLength(1)
    expect(result.notes.adjustments[0]).toMatch(/cut to 1.07 mm along the 1.27 mm pitch/)
    expect(result.notes.adjustments[0]).toMatch(/0.135 mm ring/)
  })

  test('refuses a lead it cannot size and a hole that leaves no pad', () => {
    expect(landPattern({ ...DIP_8, lead: { width: { nominal: 0.5 } } })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/lead.diameter/)
    })
    expect(landPattern({ ...DIP_8, pins: { x: 4, y: 4 } })).toMatchObject({ ok: false })
    expect(landPattern({ ...DIP_8, pitch: 1 })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/leaves no pad/)
    })
  })
})

const WLCSP_9: LandPatternInput = {
  leadType: 'grid',
  density: 'nominal',
  body: { x: { nominal: 1.2, tolerance: 0.03 }, y: { nominal: 1.2, tolerance: 0.03 } },
  ball: { diameter: { nominal: 0.25, tolerance: 0.03 } },
  pitch: 0.4,
  pins: { x: 3, y: 3 }
}

describe('landPattern, grid', () => {
  // Evidence, as above: KiCad's generator data draws a 0.5 mm ball on a 0.4 mm land.
  test('a collapsing ball lands smaller, a land or column larger', () => {
    const ball = { diameter: { nominal: 0.5 } }
    const bga = landPattern({ ...WLCSP_9, pitch: 0.8, ball })
    expect(bga.ok && bga.notes.ball).toMatchObject({ ratio: -0.2, land: 0.4, populated: 9 })
    expect(bga.ok && bga.notes.table).toMatch(/Table 3-11/)
    const lga = landPattern({ ...WLCSP_9, pitch: 0.8, ball: { ...ball, type: 'non_collapsible' } })
    expect(lga.ok && lga.notes.ball).toMatchObject({ ratio: 0.1, land: 0.55 })
    const dense = landPattern({ ...WLCSP_9, pitch: 0.8, ball, density: 'least' })
    expect(dense.ok && dense.notes.ball?.land).toBe(0.38)
  })

  test('names the grid from A1 at the top left, one array per unbroken run', () => {
    const result = landPattern({ ...WLCSP_9, skip: ['B2'] })
    if (!result.ok) throw new Error(result.detail)
    expect(result.pads.map((pad) => [pad.number, pad.array?.count ?? 1])).toEqual([
      ['A1', 3],
      ['B1', 1],
      ['B3', 1],
      ['C1', 3]
    ])
    expect(result.notes.ball?.populated).toBe(8)
    expect(
      expanded({ ...WLCSP_9, skip: ['B2'] }).map((pad) => `${pad.number}@${pad.x},${pad.y}`)
    ).toEqual([
      'A1@-0.4,-0.4',
      'A2@0,-0.4',
      'A3@0.4,-0.4',
      'B1@-0.4,0',
      'B3@0.4,0',
      'C1@-0.4,0.4',
      'C2@0,0.4',
      'C3@0.4,0.4'
    ])
    const generated = generateFootprint(
      { name: 'WLCSP-8', attributes: 'smd', pads: result.pads, body: result.body, pin1: 'A1' },
      DEFAULT_STYLE_CHOICES
    )
    expect(generated.ok && footprintChecks(parseKicadFootprint(generated.text))).toEqual([])
  })

  test('skips a block, and letters rows as JEDEC does', () => {
    const block = landPattern({ ...WLCSP_9, pitch: 0.5, pins: { x: 4, y: 4 }, skip: ['c3:B2'] })
    expect(block.ok && block.notes.ball?.populated).toBe(12)
    const tall = landPattern({ ...WLCSP_9, pins: { x: 1, y: 21 } })
    if (!tall.ok) throw new Error(tall.detail)
    const names = tall.pads.map((pad) => pad.number)
    // No I after H, and AA after Y.
    expect([names[8], names[19], names[20]]).toEqual(['J1', 'Y1', 'AA1'])
  })

  test('refuses a position off the grid, an empty grid and a land wider than the pitch', () => {
    expect(landPattern({ ...WLCSP_9, skip: ['D1'] })).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/"D1".*C3 grid/)
    })
    expect(landPattern({ ...WLCSP_9, skip: ['A1:C3'] })).toMatchObject({ ok: false })
    expect(landPattern({ ...WLCSP_9, ball: { diameter: { nominal: 0.6 } } })).toMatchObject({
      ok: false
    })
    expect(landPattern({ ...WLCSP_9, ball: undefined })).toMatchObject({ ok: false })
  })
})
