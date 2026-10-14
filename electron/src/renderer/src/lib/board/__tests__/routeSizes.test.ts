import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  extractDesignSettings,
  makeNetClass,
  patchDesignSettings,
  type BoardDesignSettings,
  type NetClass
} from '../../kicad/project'
import { boardRules } from '../rules/boardRules'
import {
  connectedTrackWidth,
  initialSizeChoice,
  resolvePairSizes,
  resolveTrackWidth,
  tuningProfileOf,
  resolveVia,
  selectionSizeLists,
  stepDrawn,
  stepIndex,
  stepViaChoice,
  stepWidthChoice,
  viaInForce,
  viaList,
  widthInForce,
  widthList,
  type SizeRule
} from '../routeSizes'

const board = parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (net 1 "GND")
  (net 2 "/USB_DP")
)`)

const cls = (name: string, trackWidth: number, viaDiameter = 0.6, viaDrill = 0.3): NetClass => ({
  ...makeNetClass(name),
  trackWidth,
  viaDiameter,
  viaDrill
})

const settings = (extra: Partial<BoardDesignSettings> = {}): BoardDesignSettings => ({
  rules: {
    ...DEFAULT_DESIGN_RULES,
    minTrackWidth: 0.1,
    minViaDiameter: 0.3,
    minThroughHoleDiameter: 0.2
  },
  classes: [cls('Default', 0.25), cls('USB', 0.2, 0.45, 0.2)],
  patterns: [{ pattern: '/USB_*', netClass: 'USB' }],
  assignments: [],
  ...extra
})

const rule = (value: number, min: number, max?: number): SizeRule<number> => ({
  value,
  min,
  ...(max !== undefined ? { max } : {}),
  source: 'test'
})

describe('resolveTrackWidth (S1)', () => {
  test('a net takes its class width, and names the class', () => {
    const r = resolveTrackWidth(boardRules(board, settings()), 2, 'F.Cu', 0.1)
    expect(r.value).toBe(0.2)
    expect(r.min).toBe(0.1)
    expect(r.source).toContain('USB')
  })

  test('no net routes as Default', () => {
    expect(resolveTrackWidth(boardRules(board, settings()), 0, 'F.Cu', 0.1).value).toBe(0.25)
  })

  test('a custom rule on a layer sets the width there only', () => {
    const text = `(version 1)
(rule inner (layer "In1.Cu") (condition "A.NetClass == 'USB'") (constraint track_width (min 0.1mm) (opt 0.12mm)))`
    const rules = boardRules(board, settings(), text)
    expect(resolveTrackWidth(rules, 2, 'In1.Cu', 0.1)).toMatchObject({ value: 0.12 })
    expect(resolveTrackWidth(rules, 2, 'F.Cu', 0.1).value).toBe(0.2)
  })

  test('never under the board minimum', () => {
    const s = settings({ classes: [cls('Default', 0.05)] })
    expect(resolveTrackWidth(boardRules(board, s), 1, 'F.Cu', 0.1).value).toBe(0.1)
  })
})

describe('tuning profiles (S12, S13)', () => {
  const pairBoard = parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (net 1 "/USB_D+")
  (net 2 "/USB_D-")
  (net 3 "/CLK")
)`)
  const usb = { ...cls('USB', 0.2), diffPairWidth: 0.2, diffPairGap: 0.25 }
  const tuned = (differential: boolean, ruleText?: string): ReturnType<typeof boardRules> =>
    boardRules(
      pairBoard,
      settings({
        classes: [cls('Default', 0.25), usb],
        patterns: [
          { pattern: '/USB_*', netClass: 'USB' },
          { pattern: '/CLK', netClass: 'USB' }
        ],
        tuning: {
          classProfiles: { USB: 'USB_90' },
          profiles: ['USB_90'],
          geometries: {
            USB_90: {
              differential,
              layers: [
                { layer: 'F.Cu', width: 0.15, gap: 0.18 },
                { layer: 'In1.Cu', width: 0.11, gap: 0.2 }
              ]
            }
          }
        }
      }),
      ruleText
    )

  test("a single profile's width per layer, the class's where it gives none, its severity ignore (S12)", () => {
    const rules = tuned(false)
    expect(resolveTrackWidth(rules, 3, 'F.Cu', 0.1)).toMatchObject({
      value: 0.15,
      min: 0.15,
      max: 0.15,
      source: "tuning profile 'USB_90'"
    })
    expect(resolveTrackWidth(rules, 3, 'In1.Cu', 0.1).value).toBe(0.11)
    expect(resolveTrackWidth(rules, 3, 'In2.Cu', 0.1)).toMatchObject({
      value: 0.2,
      source: "netclass 'USB'"
    })
  })

  test('a custom rule overrides the profile, field by field (S12)', () => {
    const text = `(version 1)
(rule wide (condition "A.NetClass == 'USB'") (constraint track_width (opt 0.3mm)))`
    // The profile's min and max still hold: the custom rule set only the preferred width.
    expect(resolveTrackWidth(tuned(false, text), 3, 'F.Cu', 0.1)).toMatchObject({
      value: 0.15,
      max: 0.15,
      source: "rule 'wide'"
    })
  })

  test("a pair's width and gap per layer from a differential profile (S13)", () => {
    const rules = tuned(true)
    const nets = { p: 1, n: 2 }
    const floor = { width: 0.1, clearance: 0.1 }
    const top = resolvePairSizes(rules, nets, 'F.Cu', floor)
    expect(top.width).toMatchObject({ value: 0.15, source: "tuning profile 'USB_90'" })
    expect(top.gap).toMatchObject({ value: 0.18, source: "tuning profile 'USB_90'" })
    expect(resolvePairSizes(rules, nets, 'In1.Cu', floor)).toMatchObject({
      width: { value: 0.11 },
      gap: { value: 0.2 }
    })
    // A layer the profile skips: the class's pair sizes.
    expect(resolvePairSizes(rules, nets, 'B.Cu', floor)).toMatchObject({
      width: { value: 0.2 },
      gap: { value: 0.25 }
    })
  })

  test("a pair's gap is never under the board's minimum clearance (S13)", () => {
    const r = resolvePairSizes(tuned(true), { p: 1, n: 2 }, 'F.Cu', { width: 0.1, clearance: 0.2 })
    expect(r.gap.value).toBe(0.2)
  })

  test('tuningProfileOf reads the profile a source names', () => {
    expect(tuningProfileOf("tuning profile 'USB_90'")).toBe('USB_90')
    expect(tuningProfileOf("netclass 'USB'")).toBeNull()
  })
})

describe('resolveVia', () => {
  test("a net takes its class's via", () => {
    const r = resolveVia(boardRules(board, settings()), 2, ['F.Cu', 'B.Cu'], {
      diameter: 0.3,
      drill: 0.2
    })
    expect(r.value).toEqual({ diameter: 0.45, drill: 0.2 })
  })
})

describe('widthList (S4)', () => {
  test("the net class's width first, then the extra sizes by size, each once", () => {
    const list = widthList(rule(0.25, 0.15), [0.5, 0.2, 0.5])
    expect(list.map((r) => r.size)).toEqual([0.25, 0.2, 0.5])
    expect(list.map((r) => r.netClass)).toEqual([true, false, false])
  })

  test('marks sizes outside the rule, and lists them (S7)', () => {
    const list = widthList(rule(0.25, 0.15, 0.8), [0.1, 1])
    expect(list.find((r) => r.size === 0.1)?.outOfRule).toBe('below')
    expect(list.find((r) => r.size === 1)?.outOfRule).toBe('above')
  })
})

describe('viaList', () => {
  test('the net class via first, then the extra vias, a via under the minimum marked', () => {
    const list = viaList(
      { value: { diameter: 0.6, drill: 0.3 }, min: { diameter: 0.4, drill: 0.2 }, source: 't' },
      [
        { diameter: 0.8, drill: 0.4 },
        { diameter: 0.3, drill: 0.15 }
      ]
    )
    expect(list.map((r) => r.size.diameter)).toEqual([0.6, 0.3, 0.8])
    expect(list[1].outOfRule).toBe('below')
  })
})

describe('stepping the route sizes (S5)', () => {
  const list = widthList(rule(0.25, 0.15), [0.18, 0.4])

  test('W steps the rows in turn and wraps back to the net class; Shift+W the other way', () => {
    let choice = initialSizeChoice()
    const widths: number[] = []
    for (let i = 0; i < 4; i++) {
      choice = stepWidthChoice(choice, list.length, 1, false)
      widths.push(widthInForce(list, choice, null, true).width)
    }
    expect(widths).toEqual([0.18, 0.4, 0.25, 0.18])
    expect(stepIndex(list.length, 0, -1)).toBe(2)
  })

  test('a picked row holds from route to route: only the override is per route', () => {
    const picked = stepWidthChoice(initialSizeChoice(), list.length, 1, false)
    const nextRoute = { ...picked, override: false }
    expect(widthInForce(list, nextRoute, null, true)).toEqual({ width: 0.18, source: 'list' })
  })

  test('a custom size holds until a row is stepped to, and steps from the row it replaced', () => {
    const custom = {
      ...initialSizeChoice(),
      custom: { width: 0.33, via: { diameter: 1, drill: 0.5 } }
    }
    expect(widthInForce(list, custom, null, true)).toEqual({ width: 0.33, source: 'custom' })
    const stepped = stepWidthChoice(custom, list.length, 1, false)
    expect(stepped.custom).toBeNull()
    expect(widthInForce(list, stepped, null, true).width).toBe(0.18)
  })

  test('the via keys step the via list, wrapping, and drop a custom size', () => {
    const vias = viaList(
      { value: { diameter: 0.6, drill: 0.3 }, min: { diameter: 0.3, drill: 0.2 }, source: 't' },
      [{ diameter: 0.8, drill: 0.4 }]
    )
    const once = stepViaChoice(initialSizeChoice(), vias.length, 1)
    expect(viaInForce(vias, once)).toEqual({ via: { diameter: 0.8, drill: 0.4 }, source: 'list' })
    expect(viaInForce(vias, stepViaChoice(once, vias.length, 1)).source).toBe('rules')
  })
})

describe('the started-from track width (R1)', () => {
  const list = widthList(rule(0.25, 0.15), [0.18, 0.4])

  test('with Use connected track width on, a route started on a track draws at its width', () => {
    expect(widthInForce(list, initialSizeChoice(), 0.5, true)).toEqual({
      width: 0.5,
      source: 'track'
    })
  })

  test('with it off, the list row holds', () => {
    expect(widthInForce(list, initialSizeChoice(), 0.5, false)).toEqual({
      width: 0.25,
      source: 'rules'
    })
  })

  test("the first W mid-route leaves the track's width for the chosen row without stepping", () => {
    const choice = { ...initialSizeChoice(), widthIndex: 2 }
    const left = stepWidthChoice(choice, list.length, 1, true)
    expect(left.widthIndex).toBe(2)
    expect(widthInForce(list, left, 0.5, true)).toEqual({ width: 0.4, source: 'list' })
  })

  test('a pad carries the width of its track on the start layer whose far end is nearest the cursor', () => {
    const at = { x: 0, y: 0 }
    const tracks = [
      { a: at, b: { x: 5, y: 0 }, width: 0.3, layer: 'F.Cu' },
      { a: { x: 0, y: 5 }, b: at, width: 0.4, layer: 'F.Cu' },
      { a: at, b: { x: -5, y: 0 }, width: 0.1, layer: 'B.Cu' },
      { a: { x: 1, y: 1 }, b: { x: 2, y: 2 }, width: 0.9, layer: 'F.Cu' }
    ]
    expect(connectedTrackWidth(tracks, at, 'F.Cu', { x: 1, y: 4 })).toBe(0.4)
    expect(connectedTrackWidth(tracks, at, 'F.Cu', { x: 4, y: 1 })).toBe(0.3)
    // None on the start layer: the narrowest of the rest.
    expect(connectedTrackWidth(tracks.slice(2), at, 'In1.Cu', at)).toBe(0.1)
    expect(connectedTrackWidth(tracks.slice(3), at, 'F.Cu', at)).toBeNull()
  })
})

describe('extra sizes in the project', () => {
  test("reads track_widths and via_dimensions, skipping KiCad's net-class placeholder", () => {
    const pro = JSON.stringify({
      board: {
        design_settings: {
          track_widths: [0.0, 0.2, 0.5],
          via_dimensions: [
            { diameter: 0.0, drill: 0.0 },
            { diameter: 0.8, drill: 0.4 }
          ]
        }
      }
    })
    expect(extractDesignSettings(pro)?.extraSizes).toEqual({
      tracks: [0.2, 0.5],
      vias: [{ diameter: 0.8, drill: 0.4 }]
    })
  })

  test('reads diff_pair_dimensions, the list W steps while a pair is routed (S5)', () => {
    const pro = JSON.stringify({
      board: {
        design_settings: {
          diff_pair_dimensions: [
            { width: 0.0, gap: 0.0, via_gap: 0.0 },
            { width: 0.15, gap: 0.12, via_gap: 0.2 }
          ]
        }
      }
    })
    expect(extractDesignSettings(pro)?.pairSizes).toEqual([{ width: 0.15, gap: 0.12, viaGap: 0.2 }])
  })
})

describe('stepDrawn (S9)', () => {
  const list = widthList(rule(0.25, 0.15), [0.18, 0.4])
  const step = (current: number, dir: 1 | -1): number => stepDrawn(list, (w) => w, current, dir)

  test('a track steps to the nearest size of the list past its own', () => {
    expect(step(0.25, 1)).toBe(0.4)
    expect(step(0.25, -1)).toBe(0.18)
    expect(step(0.3, -1)).toBe(0.25)
  })

  test('a track at the end of the list stays', () => {
    expect(step(0.4, 1)).toBe(0.4)
    expect(step(0.18, -1)).toBe(0.18)
  })

  test("the selection's list leads with the Default class's size, whatever the item's net, as KiCad's", () => {
    const own = { name: 'Default', trackWidth: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }
    const { widths, vias } = selectionSizeLists(own, {
      tracks: [0.4, 0.15],
      vias: [{ diameter: 0.8, drill: 0.4 }]
    })
    expect(widths.map((row) => row.size)).toEqual([0.2, 0.15, 0.4])
    expect(vias.map((row) => row.size)).toEqual([
      { diameter: 0.6, drill: 0.3 },
      { diameter: 0.8, drill: 0.4 }
    ])
    // A 0.3 mm track of a wider class steps down to Default's, not to its own class's.
    expect(stepDrawn(widths, (w) => w, 0.3, -1)).toBe(0.2)
  })
})

describe('writing extra sizes', () => {
  const base = settings()
  test("KiCad's zero entry leads each list, and a file without them stays without", () => {
    const written = patchDesignSettings('{}', {
      ...base,
      extraSizes: { tracks: [0.3], vias: [{ diameter: 0.8, drill: 0.4 }] }
    })!
    const ds = JSON.parse(written).board.design_settings
    expect(ds.track_widths).toEqual([0, 0.3])
    expect(ds.via_dimensions).toEqual([
      { diameter: 0, drill: 0 },
      { diameter: 0.8, drill: 0.4 }
    ])
    expect(extractDesignSettings(written)?.extraSizes?.tracks).toEqual([0.3])
    const none = JSON.parse(
      patchDesignSettings('{}', { ...base, extraSizes: { tracks: [], vias: [] } })!
    ).board.design_settings
    expect('track_widths' in none).toBe(false)
  })
})
