import { describe, expect, it } from 'vitest'
import { parseKicadFootprint } from '../../kicad/footprint'
import { mmToNm } from '../../kicad/coordinates'
import { generateFootprint, expandPads, type FootprintSpec } from '../footprintGenerate'
import { FOOTPRINT_CHECK_RULES, footprintChecks } from '../footprintChecks'
import { locateItems } from '../footprintItems'
import { DEFAULT_STYLE_CHOICES, roundrectRatio } from '../footprintStyle'
import { pinCheck } from '../pinCheck'
import { JST_PH_4, QFN_20 } from './footprintFixtures'

const generate = (
  spec: FootprintSpec,
  style = DEFAULT_STYLE_CHOICES
): Extract<ReturnType<typeof generateFootprint>, { ok: true }> => {
  const result = generateFootprint(spec, style)
  if (!result.ok) throw new Error(`${result.error}: ${result.detail}`)
  return result
}

describe('roundrectRatio', () => {
  it('is 0.25 until the radius reaches 0.25 mm', () => {
    expect(roundrectRatio(mmToNm(0.5), mmToNm(0.8))).toBe(0.25)
    // KiCad's own JST PH pad: 1.2 mm wide → 0.208333.
    expect(roundrectRatio(mmToNm(1.2), mmToNm(1.75))).toBe(0.208333)
  })
})

describe('expandPads', () => {
  it('unrolls an array and numbers it', () => {
    const expanded = expandPads(QFN_20.pads)
    expect(expanded.ok).toBe(true)
    if (!expanded.ok) return
    expect(expanded.pads.map((pad) => pad.number)).toEqual(
      Array.from({ length: 21 }, (_, i) => String(i + 1))
    )
    expect(expanded.pads[4].at).toEqual({ x: mmToNm(-1.45), y: mmToNm(0.8) })
    expect(expanded.pads[10].at).toEqual({ x: mmToNm(1.45), y: mmToNm(0.8) })
  })

  it('defaults layers by type', () => {
    const expanded = expandPads(JST_PH_4.pads)
    expect(expanded.ok && expanded.pads[0].layers).toEqual(['*.Cu', '*.Mask'])
    const smd = expandPads(QFN_20.pads)
    expect(smd.ok && smd.pads[0].layers).toEqual(['F.Cu', 'F.Paste', 'F.Mask'])
  })

  it('counts up the digits of a lettered number, as a row of balls is named', () => {
    const row = expandPads([
      { ...QFN_20.pads[0], number: 'AB3', array: { count: 3, dx: 1, dy: 0 } }
    ])
    expect(row.ok && row.pads.map((pad) => pad.number)).toEqual(['AB3', 'AB4', 'AB5'])
  })

  it('refuses a named array and a short one', () => {
    const named = expandPads([{ ...QFN_20.pads[0], number: 'MP' }])
    expect(named).toMatchObject({ ok: false, error: 'bad-array' })
    const short = expandPads([{ ...QFN_20.pads[0], array: { count: 1, dx: 0, dy: 1 } }])
    expect(short).toMatchObject({ ok: false, error: 'bad-array' })
  })

  it('refuses a zero pad and a hole with no drill', () => {
    expect(expandPads([{ ...QFN_20.pads[4], size: { width: 0, height: 1 } }])).toMatchObject({
      error: 'bad-pad'
    })
    expect(expandPads([{ ...JST_PH_4.pads[0], drill: undefined }])).toMatchObject({
      error: 'bad-pad'
    })
  })
})

describe('generateFootprint refusals', () => {
  it('refuses overlapping pads of different numbers', () => {
    const result = generateFootprint(
      {
        ...QFN_20,
        pads: [
          { ...QFN_20.pads[4], number: '1' },
          { ...QFN_20.pads[4], number: '2', at: { x: 0.5, y: 0 } }
        ]
      },
      DEFAULT_STYLE_CHOICES
    )
    expect(result).toMatchObject({ ok: false, error: 'pads-overlap' })
  })

  it('writes overlapping pads that share a number', () => {
    const result = generateFootprint(
      {
        ...QFN_20,
        pads: [
          { ...QFN_20.pads[4], number: 'MP' },
          { ...QFN_20.pads[4], number: 'MP', at: { x: 0.5, y: 0 } }
        ],
        pin1: 'MP'
      },
      DEFAULT_STYLE_CHOICES
    )
    expect(result.ok && result.report.sharedNumbers).toEqual(['MP'])
  })

  it('does not report unnumbered mounting holes as shared', () => {
    const hole = {
      number: '',
      type: 'np_thru_hole' as const,
      shape: 'circle' as const,
      size: { width: 3, height: 3 },
      drill: { diameter: 3 }
    }
    const result = generateFootprint(
      {
        ...JST_PH_4,
        pads: [...JST_PH_4.pads, { ...hole, at: { x: 0, y: 4 } }, { ...hole, at: { x: 6, y: 4 } }],
        body: { rect: { x: -1.95, y: -1.7, width: 9.9, height: 7.5 } }
      },
      DEFAULT_STYLE_CHOICES
    )
    expect(result.ok && result.report.sharedNumbers).toEqual([])
  })

  it('needs pin1 with more than one pad, and one that exists', () => {
    expect(generateFootprint({ ...QFN_20, pin1: undefined }, DEFAULT_STYLE_CHOICES)).toMatchObject({
      error: 'bad-pin1'
    })
    expect(generateFootprint({ ...QFN_20, pin1: '99' }, DEFAULT_STYLE_CHOICES)).toMatchObject({
      error: 'bad-pin1'
    })
  })

  it('refuses a name no file system takes', () => {
    expect(generateFootprint({ ...QFN_20, name: 'a/b' }, DEFAULT_STYLE_CHOICES)).toMatchObject({
      error: 'bad-name'
    })
    expect(generateFootprint({ ...QFN_20, name: '  ' }, DEFAULT_STYLE_CHOICES)).toMatchObject({
      error: 'blank-name'
    })
  })

  it('refuses an empty body', () => {
    expect(
      generateFootprint(
        { ...QFN_20, body: { rect: { x: 0, y: 0, width: 0, height: 1 } } },
        DEFAULT_STYLE_CHOICES
      )
    ).toMatchObject({ error: 'bad-body' })
  })
})

describe('generateFootprint', () => {
  it('draws a connector that passes every check', () => {
    const result = generate(JST_PH_4)
    const footprint = parseKicadFootprint(result.text)
    expect(footprint.name).toBe(JST_PH_4.name)
    expect(footprint.attributes).toEqual(['through_hole'])
    expect(footprint.pads.map((pad) => pad.number)).toEqual(['1', '2', '3', '4'])
    expect(footprint.pads[0].roundrectRatio).toBe(0.208333)
    expect(footprintChecks(footprint, { klc: true })).toEqual([])
  })

  it('draws a QFN that passes every check', () => {
    const result = generate(QFN_20)
    const footprint = parseKicadFootprint(result.text)
    expect(footprint.pads).toHaveLength(21)
    expect(footprint.attributes).toEqual(['smd'])
    expect(footprintChecks(footprint, { klc: true })).toEqual([])
    // The body is inside the pads' reach, so the silk is cut to corner stubs.
    expect(result.report.derived.silk.cutNearPads).toBe(4)
  })

  it('grows the courtyard by the class offset, on the 0.01 grid', () => {
    const result = generate(JST_PH_4)
    // Body −1.95…7.95 × −1.7…2.8, pads inside it; connector offset 0.5.
    expect(result.report.derived.courtyard).toEqual({
      offset: 0.5,
      box: { x: -2.45, y: -2.2, width: 10.9, height: 5.5 }
    })
    // KiCad's own B2B-PH-K courtyard starts at the same corner.
  })

  it('takes the union of pads and body for the courtyard', () => {
    const result = generate(QFN_20)
    // Pads reach ±1.875; the body only ±1.5.
    expect(result.report.box.courtyard).toEqual({ x: -2.13, y: -2.13, width: 4.26, height: 4.26 })
  })

  it('bevels the fab corner nearest pin 1', () => {
    const result = generate(JST_PH_4)
    expect(result.report.derived.bevel).toEqual({ corner: { x: -1.95, y: -1.7 }, size: 1 })
    const qfn = generate(QFN_20)
    expect(qfn.report.derived.bevel).toEqual({ corner: { x: -1.5, y: -1.5 }, size: 0.75 })
  })

  it('writes the texts to the library style', () => {
    const footprint = parseKicadFootprint(generate(JST_PH_4).text)
    const reference = footprint.properties.find((p) => p.key === 'Reference')
    expect(reference?.layer).toBe('F.SilkS')
    expect(reference?.position).toMatchObject({ x: mmToNm(3), y: mmToNm(-2.7) })
    const value = footprint.properties.find((p) => p.key === 'Value')
    expect(value?.value).toBe(JST_PH_4.name)
    expect(value?.position).toMatchObject({ y: mmToNm(3.8) })
    const generator = footprint.properties.find((p) => p.key === 'GoatCAD_Generator')
    expect(generator?.hide).toBe(true)
    expect(footprint.fpTexts.map((t) => t.text)).toEqual(['${REFERENCE}'])
  })

  it('keeps every silk stroke clear of the pads for each marker', () => {
    for (const pin1Marker of ['chevron', 'dot', 'line'] as const) {
      for (const spec of [JST_PH_4, QFN_20]) {
        const result = generate(spec, { ...DEFAULT_STYLE_CHOICES, pin1Marker })
        const footprint = parseKicadFootprint(result.text)
        expect(footprintChecks(footprint, { klc: true }), `${spec.name} ${pin1Marker}`).toEqual([])
        expect(result.report.derived.pin1Marker?.at, `${spec.name} ${pin1Marker}`).not.toBeNull()
      }
    }
  })

  it('draws a dot as a filled circle beside pad 1', () => {
    const result = generate(JST_PH_4, { ...DEFAULT_STYLE_CHOICES, pin1Marker: 'dot' })
    const footprint = parseKicadFootprint(result.text)
    expect(footprint.fpCircles).toHaveLength(1)
    expect(footprint.fpCircles[0].fill).toBe('solid')
    expect(result.report.derived.pin1Marker).toMatchObject({ kind: 'dot' })
  })

  it('writes the datasheet as a hidden property', () => {
    const footprint = parseKicadFootprint(
      generate({ ...QFN_20, datasheet: 'https://example.com/ds.pdf' }).text
    )
    expect(footprint.properties.find((p) => p.key === 'Datasheet')).toMatchObject({
      value: 'https://example.com/ds.pdf',
      hide: true
    })
  })

  it('round-trips through the serializer unchanged', async () => {
    const { serializeKicadFootprint } = await import('../../kicad/footprint')
    const text = generate(QFN_20).text
    expect(serializeKicadFootprint(parseKicadFootprint(text))).toBe(text)
  })
})

describe('footprintChecks', () => {
  const HEAD = `(footprint "T" (layer "F.Cu") (attr smd)
  (property "Reference" "REF**" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "T" (at 0 3 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))`
  const COURTYARD = '(fp_rect (start -2 -2) (end 2 2) (stroke (width 0.05)) (layer "F.CrtYd"))'
  const fp = (body: string, head = HEAD): ReturnType<typeof parseKicadFootprint> =>
    parseKicadFootprint(`${head}\n${body})`)
  const codes = (body: string, klc = false): string[] =>
    footprintChecks(fp(`${COURTYARD} ${body}`), { klc }).map((r) => r.code)
  const SMD = (
    number: string,
    x: number,
    layers = '"F.Cu" "F.Paste" "F.Mask"',
    extra = ''
  ): string => `(pad "${number}" smd rect (at ${x} 0) (size 0.5 0.5) (layers ${layers}) ${extra})`

  it('flags silk only where it crosses a mask opening, as KiCad does', () => {
    const line = (y: number): string =>
      `(fp_line (start -1 ${y}) (end 1 ${y}) (stroke (width 0.12)) (layer "F.SilkS"))`
    expect(codes(`${line(0)} ${SMD('1', 0)}`)).toEqual(['silk-clipped-by-mask'])
    // 0.1 mm clear: KLC's 0.2 mm is house style, not KiCad's rule.
    expect(codes(`${line(0.41)} ${SMD('1', 0)}`)).toEqual([])
    // The pad's mask margin grows the opening; a pad with no mask has none.
    expect(codes(`${line(0.41)} ${SMD('1', 0, undefined, '(solder_mask_margin 0.2)')}`)).toEqual([
      'silk-clipped-by-mask'
    ])
    expect(codes(`${line(0)} ${SMD('1', 0, '"F.Cu"')}`)).toEqual([])
  })

  it('shorts copper, not one logical pad, not across sides, not a stencil opening', () => {
    expect(codes(`${SMD('1', 0)} ${SMD('2', 0.4)}`)).toEqual(['pads-overlap'])
    expect(codes(`${SMD('MP', 0)} ${SMD('MP', 0.4)}`)).toEqual([])
    expect(codes(`${SMD('1', 0)} ${SMD('2', 0.4, '"B.Cu" "B.Mask"')}`)).toEqual([])
    expect(codes(`${SMD('1', 0)} ${SMD('', 0.1, '"F.Paste"')}`)).toEqual([])
    // Two unnumbered pads are not one logical pad.
    expect(codes(`${SMD('', 0)} ${SMD('', 0.4)}`)).toEqual(['pads-overlap'])
  })

  it('takes a hole no bigger than its pad for a hole, and a circle for a circle', () => {
    const npth = (size: number): string =>
      `(pad "" np_thru_hole circle (at 0 0) (size ${size} ${size}) (drill 1) (layers "*.Cu" "*.Mask"))`
    const beside = '(pad "1" smd rect (at 0.6 0) (size 0.4 0.4) (layers "F.Cu" "F.Mask"))'
    // No ring, so no copper to short: KiCad's IsOnCopperLayer.
    expect(codes(`${npth(1)} ${beside}`)).toEqual([])
    expect(codes(`${npth(1.4)} ${beside}`)).toEqual(['pads-overlap'])
    // A silk ring 0.001 mm clear of the opening: coarse chords would cut into it.
    const ring = '(fp_circle (center 0 0) (end 0.566 0) (stroke (width 0.12)) (layer "F.SilkS"))'
    expect(codes(`${npth(1)} ${ring}`)).toEqual([])
  })

  it('checks pads as PAD::CheckPad does', () => {
    const message = (body: string): string[] =>
      footprintChecks(fp(`${COURTYARD} ${body}`)).map((r) => `${r.code}: ${r.message}`)
    expect(message(SMD('1', 0, '"*.Cu" "F.Mask"'))).toEqual([
      'padstack: Pad 1: SMD pad has copper on both sides of the board.'
    ])
    expect(message(SMD('1', 0, '"F.Cu" "B.Mask"'))).toEqual([
      'padstack: Pad 1: SMD pad has copper and mask layers on different sides of the board.'
    ])
    // KiCad reads no hole into an SMD pad, whatever its file says.
    expect(message(SMD('1', 0, undefined, '(drill 0.3)'))).toEqual([])
    // A through-hole pad on one side, or with paste, is fine by KiCad.
    const tht = (layers: string, drill = '(drill 0.8)', size = '1.6 1.6'): string =>
      `(pad "1" thru_hole circle (at 0 0) (size ${size}) ${drill} (layers ${layers}))`
    expect(message(tht('"F.Cu" "F.Mask" "F.Paste"'))).toEqual([])
    // A through-hole pad with no drill loads with a 1 nm one; only a drill of 0 is none.
    expect(message(tht('"*.Cu" "*.Mask"', ''))).toEqual([
      'padstack-invalid: Pad 1: PTH pad hole size must be larger than 0.000004 mm.'
    ])
    expect(message(tht('"*.Cu" "*.Mask"', '(drill 0)'))).toEqual([
      'through-hole-pad-without-hole: Pad 1 is through hole with no drill.'
    ])
    expect(message(tht('"*.Cu" "*.Mask"', '(drill 1.8)'))).toEqual([
      'padstack: Pad 1: PTH pad hole leaves no copper.'
    ])
    expect(
      message(
        `(pad "1" smd rect (at 0 0) (size 0.5 0.5) (property pad_prop_castellated) (layers "F.Cu" "F.Mask"))`
      )
    ).toEqual(["padstack: Pad 1: 'castellated' pads are normally PTH."])
  })

  it('warns of holes at one point, or touching', () => {
    const hole = (x: number): string =>
      `(pad "" np_thru_hole circle (at ${x} 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))`
    expect(codes(`${hole(0)} ${hole(0)}`)).toContain('holes-co-located')
    expect(codes(`${hole(0)} ${hole(0.9)}`)).toContain('hole-to-hole')
    expect(codes(`${hole(0)} ${hole(1.1)}`)).toEqual([])
  })

  it('joins courtyard ends within 0.02 mm, as KiCad chains them, and ignores a missing one', () => {
    const courtyard = (gap: number): string[] =>
      footprintChecks(
        fp(`(fp_line (start -1 -1) (end 1 -1) (stroke (width 0.05)) (layer "F.CrtYd"))
  (fp_arc (start ${1 + gap} -1) (mid 2 0) (end 1 1) (stroke (width 0.05)) (layer "F.CrtYd"))
  (fp_line (start 1 1) (end -1 1) (stroke (width 0.05)) (layer "F.CrtYd"))
  (fp_line (start -1 1) (end -1 -1) (stroke (width 0.05)) (layer "F.CrtYd"))
  ${SMD('1', 0)}`)
      ).map((r) => r.message)
    expect(courtyard(0.006)).toEqual([])
    expect(courtyard(0.03)).toEqual(['The F.CrtYd outline is not closed.'])
    // A zero-length stray on the outline chains to nothing, as KiCad reads it.
    expect(
      footprintChecks(
        fp(
          `${COURTYARD} (fp_line (start 0 -2) (end 0 -2) (stroke (width 0.05)) (layer "F.CrtYd")) ${SMD('1', 0)}`
        )
      ).map((r) => r.code)
    ).toEqual(['malformed-courtyard'])
    // KiCad ignores a missing courtyard by default; KLC asks for one.
    expect(footprintChecks(fp(SMD('1', 0))).map((r) => r.code)).toEqual([])
    expect(footprintChecks(fp(SMD('1', 0)), { klc: true }).map((r) => r.code)).toEqual([
      'missing-courtyard'
    ])
  })

  it('lets a net tie join its group, and nothing else', () => {
    const tie = (groups: string, pads: string): string[] =>
      footprintChecks(
        fp(
          `(net_tie_pad_groups ${groups}) ${COURTYARD}
  (fp_line (start -1 0) (end 1 0) (stroke (width 0.2)) (layer "F.Cu")) ${pads}`
        )
      ).map((r) => r.code)
    const pads = `${SMD('1', -1, '"F.Cu" "F.Mask"')} ${SMD('2', 1, '"F.Cu" "F.Mask"')}`
    expect(tie('"1, 2"', pads)).toEqual([])
    expect(tie('"1, 3"', pads)).toEqual(['net-tie-groups', 'net-tie-short'])
  })

  it('runs KLC as a style profile, with its accepted ranges', () => {
    const silk = (width: number): string =>
      `(fp_line (start -1 -1.5) (end 1 -1.5) (stroke (width ${width})) (layer "F.SilkS"))`
    expect(codes(`${silk(0.15)} ${SMD('1', 0)}`, true)).toEqual([])
    expect(codes(`${silk(0.165)} ${SMD('1', 0)}`, true)).toEqual(['silk-width'])
    expect(codes(`${silk(0.165)} ${SMD('1', 0)}`)).toEqual([])
    const texts = (reference: string, value: string): string[] =>
      footprintChecks(
        parseKicadFootprint(`(footprint "T" (layer "F.Cu") (attr smd)
  (property "Reference" "REF**" (at 0 -3 0) (layer "${reference}") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "T" (at 0 3 0) (layer "${value}") (effects (font (size 0.8 0.8) (thickness 0.12))))
  ${COURTYARD} ${SMD('1', 0)})`),
        { klc: true }
      ).map((r) => r.code)
    expect(texts('F.SilkS', 'B.Fab')).toEqual([])
    expect(texts('F.Fab', 'F.SilkS')).toEqual(['reference-text', 'value-text'])
    expect(
      codes(
        `(pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask"))`,
        true
      )
    ).toEqual(['footprint-type-mismatch'])
    expect(codes(SMD('1', 3), true)).toEqual(['courtyard-enclosure'])
  })
})

describe('every footprint rule selects what it reports', () => {
  // Every rule fires somewhere in these, on pads without uuids and sharing
  // numbers: the case a `pad:<n>` name cannot select. A rule about the whole
  // footprint has nothing to select.
  const WHOLE_FOOTPRINT = new Set([
    'net-tie-groups',
    'missing-courtyard',
    'footprint-type-mismatch'
  ])
  const sources = [
    `(footprint "A" (layer "F.Cu") (attr through_hole) (net_tie_pad_groups "1, 9")
  (property "Reference" "REF**" (at 0 -3 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "A" (at 0 3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (fp_line (start -0.5 -0.5) (end 0.5 -0.5) (stroke (width 0.05)) (layer "F.CrtYd"))
  (fp_line (start -2 0) (end 2 0) (stroke (width 0.165)) (layer "F.SilkS"))
  (fp_line (start -3 3) (end 3 3) (stroke (width 0.2)) (layer "F.Cu"))
  (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "*.Cu" "F.Mask"))
  (pad "2" smd rect (at 0.4 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
  (pad "3" smd rect (at -3 3) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
  (pad "4" smd rect (at 3 3) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
  (pad "5" thru_hole circle (at 6 0) (size 1 1) (layers "*.Cu" "*.Mask"))
  (pad "MP" thru_hole circle (at -3 0) (size 1 1) (drill 0) (layers "*.Cu" "*.Mask"))
  (pad "MP" np_thru_hole circle (at 3 -3) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))
  (pad "MP" np_thru_hole circle (at 3 -3) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))
  (pad "MP" np_thru_hole circle (at 3.9 -3) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask")))`,
    `(footprint "B" (layer "F.Cu") (attr smd)
  (property "Reference" "REF**" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "B" (at 0 3 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
  (pad "2" thru_hole circle (at 3 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask")))`
  ]
  const all = sources.map((source) => {
    const fp = parseKicadFootprint(source)
    return { fp, results: footprintChecks(fp, { klc: true }) }
  })

  it.each(Object.keys(FOOTPRINT_CHECK_RULES))('%s', (code) => {
    const found = all.flatMap(({ fp, results }) =>
      results.filter((result) => result.code === code).map((result) => ({ fp, result }))
    )
    expect(found.length).toBeGreaterThan(0)
    for (const { fp, result } of found) {
      if (WHOLE_FOOTPRINT.has(code)) continue
      expect(result.targets?.length).toBeGreaterThan(0)
      expect(locateItems(fp, result.targets!).selection).toHaveLength(result.targets!.length)
    }
  })
})

describe('pinCheck', () => {
  it('compares by number, a shared pad as one pin', () => {
    expect(pinCheck(['1', '2', '3', 'MP', 'MP'], ['1', '2', '4'])).toEqual({
      matched: 2,
      padsWithoutPin: ['3', 'MP'],
      pinsWithoutPad: ['4']
    })
  })
})

describe('the line marker', () => {
  /** SOIC-8: pads outside the body, as a gullwing package has them. */
  const SOIC_8: FootprintSpec = {
    name: 'SOIC-8_3.9x4.9mm_P1.27mm',
    attributes: 'smd',
    pads: [
      {
        number: '1',
        type: 'smd',
        shape: 'roundrect',
        at: { x: -2.475, y: -1.905 },
        size: { width: 1.95, height: 0.6 },
        array: { count: 4, dx: 0, dy: 1.27 }
      },
      {
        number: '5',
        type: 'smd',
        shape: 'roundrect',
        at: { x: 2.475, y: 1.905 },
        size: { width: 1.95, height: 0.6 },
        array: { count: 4, dx: 0, dy: -1.27 }
      }
    ],
    body: { rect: { x: -1.95, y: -2.45, width: 3.9, height: 4.9 } },
    pin1: '1'
  }

  it('runs the top edge on past pad 1 on a gullwing part', () => {
    const result = generate(SOIC_8, { ...DEFAULT_STYLE_CHOICES, pin1Marker: 'line' })
    expect(result.report.derived.pin1Marker).toEqual({
      kind: 'line',
      at: { x: -3.95, y: -2.56 }
    })
    expect(footprintChecks(parseKicadFootprint(result.text))).toEqual([])
  })

  it('falls back to a chevron when pad 1 is inside the outline', () => {
    const result = generate(QFN_20, { ...DEFAULT_STYLE_CHOICES, pin1Marker: 'line' })
    expect(result.report.derived.pin1Marker).toMatchObject({ kind: 'chevron' })
    expect(result.report.derived.pin1Marker?.note).toMatch(/within the outline/)
  })
})
