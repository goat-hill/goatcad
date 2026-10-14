import { describe, expect, test } from 'vitest'
import { boardSetupRecord, planBoardSetup, stackupSpecOf } from '../boardSetup'
import { parseKicadBoard, setBoardStackupInAST, type KicadBoard } from '../../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  makeNetClass,
  type BoardDesignSettings
} from '../../kicad/project'
import { DRC_CATALOG } from '../drcCatalog'
import { findProfile } from '../../manufacturingProfiles'

const BOARD = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
)`

const settings = (): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES },
  classes: [...DEFAULT_NET_CLASSES, makeNetClass('Power')],
  patterns: [{ pattern: 'VBUS', netClass: 'Power' }],
  assignments: [],
  severities: {}
})

const plan = (
  changes: Record<string, unknown>,
  board: KicadBoard = parseKicadBoard(BOARD)
): ReturnType<typeof planBoardSetup> =>
  planBoardSetup({ board, settings: settings(), catalog: DRC_CATALOG, hasProject: true }, changes)

describe('stackupSpecOf', () => {
  test("a catalog build's own prepreg survives a regeneration", () => {
    const board = parseKicadBoard(BOARD)
    const preset = findProfile('jlcpcb-4l-1.6')!.stackups[1] // JLC04161H-3313
    setBoardStackupInAST(board, preset.spec)
    const read = stackupSpecOf(board)
    expect(read).toMatchObject({ prepregThickness: 0.0994, prepregEpsilonR: 4.1, epsilonR: 4.6 })
    setBoardStackupInAST(board, { ...read, maskColor: 'Black' })
    expect(stackupSpecOf(board)).toMatchObject({ prepregThickness: 0.0994, prepregEpsilonR: 4.1 })
  })

  test('reads the board back in millimetres, as the form holds it', () => {
    const board = parseKicadBoard(BOARD)
    setBoardStackupInAST(board, { ...stackupSpecOf(board), copperLayers: 4, boardThickness: 1.6 })
    const spec = stackupSpecOf(board)
    expect(spec.copperLayers).toBe(4)
    expect(spec.boardThickness).toBeCloseTo(1.6, 6)
    expect(spec.copperThickness).toBeLessThan(0.1)
    // A second regeneration from what was read keeps the build: the units survive the round trip.
    setBoardStackupInAST(board, stackupSpecOf(board))
    expect(stackupSpecOf(board)).toEqual(spec)
  })
})

describe('the setup record', () => {
  test('answers each section in the shape an update takes, and only those asked', () => {
    const record = boardSetupRecord(
      {
        board: parseKicadBoard(BOARD),
        settings: settings(),
        catalog: DRC_CATALOG,
        results: null,
        hasProject: true
      },
      ['general', 'netClasses', 'severities']
    )
    expect(Object.keys(record).sort()).toEqual(['general', 'netClasses', 'severities'])
    expect(record.general).toEqual({
      paper: 'A4',
      gridOrigin: { x: 0, y: 0 },
      drillOrigin: { x: 0, y: 0 }
    })
    const classes = (record.netClasses as { classes: Array<{ name: string }> }).classes
    expect(classes.map((c) => c.name)).toEqual(['Default', 'Power'])
    const severities = record.severities as { rules: Record<string, string>; notChecked: string[] }
    expect(severities.rules.clearance).toBe('error')
    // Every rule KiCad 10 ranks is checked.
    expect(severities.notChecked).toEqual([])
  })

  test('net classes list the nets each pattern matched, and Default the rest, capped', () => {
    const nets = ['VBUS', '/USB/VBUS', 'GND', 'unconnected-(J1-Pad3)']
    const many = Array.from({ length: 101 }, (_, i) => `N${i}`)
    const used = [...nets, ...many]
    // A net only the table declares (a session's earlier parse keeps them) matches nothing.
    const declared = [...used, 'STALE']
    const board = parseKicadBoard(
      BOARD.replace(
        '(net 0 "")',
        [
          '(net 0 "")',
          ...declared.map((name, i) => `(net ${i + 1} "${name}")`),
          ...used.map(
            (_, i) =>
              `(segment (start 0 ${i}) (end 1 ${i}) (width 0.2) (layer "F.Cu") (net ${i + 1}))`
          )
        ].join(' ')
      )
    )
    const record = boardSetupRecord(
      {
        board,
        settings: {
          ...settings(),
          patterns: [
            { pattern: '*VBUS', netClass: 'Power' },
            { pattern: '/MCU/USB_D*', netClass: 'Power' }
          ]
        },
        catalog: DRC_CATALOG,
        results: null,
        hasProject: true
      },
      ['netClasses']
    )
    const matched = (record.netClasses as { matched: Array<Record<string, unknown>> }).matched
    expect(matched[0]).toEqual({
      pattern: '*VBUS',
      netClass: 'Power',
      count: 2,
      nets: ['VBUS', '/USB/VBUS']
    })
    expect(matched[1]).toEqual({ pattern: '/MCU/USB_D*', netClass: 'Power', count: 0, nets: [] })
    // Default's are those nothing else takes; an unconnected pad's net is no one's.
    expect(matched[2]).toMatchObject({ netClass: 'Default', count: 102, truncated: true })
    expect((matched[2].nets as string[]).slice(0, 2)).toEqual(['GND', 'N0'])
    expect((matched[2].nets as string[]).length).toBe(100)
  })
})

describe('planning an update', () => {
  test('a profile seeds the rules, the Default class and the stackup, and the rest lands on top', () => {
    const profile = findProfile('jlcpcb-4l-1.6')!
    const planned = plan({ profile: profile.id, constraints: { minClearance: 0.15 } })
    if (!planned.ok) throw new Error(planned.detail)
    const { design } = planned.plan.project
    expect(design?.rules.minClearance).toBe(0.15)
    expect(design?.rules.minTrackWidth).toBe(profile.rules.minTrackWidth)
    expect(design?.classes[0].trackWidth).toBe(profile.defaults.trackWidth)
    expect(planned.plan.board.stackup?.copperLayers).toBe(4)
    expect(planned.plan.before.constraints).toEqual({
      minClearance: DEFAULT_DESIGN_RULES.minClearance
    })
  })

  test('the picks are stored: a profile and its build, a named build, a hand-built one as Custom', () => {
    const choiceOf = (changes: Record<string, unknown>): unknown => {
      const planned = plan(changes)
      if (!planned.ok) throw new Error(planned.detail)
      return planned.plan.project.choice
    }
    expect(choiceOf({ profile: 'oshpark-4l-1.6' })).toEqual({
      profile: 'oshpark-4l-1.6',
      stackup: 'oshpark-4l-1.6-fr408hr'
    })
    expect(choiceOf({ stackup: { preset: 'jlcpcb-4l-1.6-3313' } })).toEqual({
      stackup: 'jlcpcb-4l-1.6-3313'
    })
    expect(choiceOf({ stackup: { preset: 'jlcpcb-4l-1.6-3313', maskColor: 'Black' } })).toEqual({
      stackup: null
    })
    expect(choiceOf({ constraints: { minClearance: 0.15 } })).toBeUndefined()
  })

  test('net classes: add from Default, rename carrying patterns, remove dropping them', () => {
    const planned = plan({
      netClasses: {
        upsert: [{ name: 'USB', trackWidth: 0.3 }],
        rename: [{ from: 'Power', to: 'Supply' }]
      }
    })
    if (!planned.ok) throw new Error(planned.detail)
    const design = planned.plan.project.design!
    expect(design.classes.map((c) => c.name)).toEqual(['Default', 'Supply', 'USB'])
    expect(design.classes[2].trackWidth).toBe(0.3)
    expect(design.patterns).toEqual([{ pattern: 'VBUS', netClass: 'Supply' }])

    const removed = plan({ netClasses: { remove: ['Power'] } })
    if (!removed.ok) throw new Error(removed.detail)
    expect(removed.plan.project.design!.patterns).toEqual([])
  })

  test("net classes: the route tool's extra sizes, each list whole", () => {
    const planned = plan({
      netClasses: { extraSizes: { tracks: [0.2, 0.5], vias: [{ size: 0.8, drill: 0.4 }] } }
    })
    if (!planned.ok) throw new Error(planned.detail)
    expect(planned.plan.project.design!.extraSizes).toEqual({
      tracks: [0.2, 0.5],
      vias: [{ diameter: 0.8, drill: 0.4 }]
    })
    // Answered as written: a via's diameter is size, as on a via record.
    expect(planned.plan.changed.netClasses).toMatchObject({
      extraSizes: { vias: [{ size: 0.8, drill: 0.4 }] }
    })
    expect(
      plan({ netClasses: { extraSizes: { vias: [{ size: 0.4, drill: 0.4 }] } } })
    ).toMatchObject({ ok: false, error: 'invalid-record' })
    // The old name is gone, not aliased.
    expect(
      plan({ netClasses: { extraSizes: { vias: [{ diameter: 0.8, drill: 0.4 }] } } })
    ).toMatchObject({ ok: false, error: 'invalid-record' })
    expect(plan({ netClasses: { extraSizes: { tracks: [0] } } })).toMatchObject({ ok: false })
  })

  test('refusals name what is wrong and write nothing', () => {
    expect(plan({ netClasses: { remove: ['Default'] } })).toMatchObject({
      ok: false,
      error: 'not-applicable'
    })
    expect(plan({ netClasses: { patterns: [{ pattern: 'X', netClass: 'Nope' }] } })).toMatchObject({
      ok: false,
      candidates: ['Default', 'Power']
    })
    expect(plan({ stackup: { copperLayers: 3 } })).toMatchObject({
      ok: false,
      error: 'invalid-record'
    })
    expect(plan({ severities: { clearence: 'ignore' } })).toMatchObject({
      ok: false,
      error: 'invalid-record'
    })
    expect(plan({ severities: { clearance: 'loud' } })).toMatchObject({
      ok: false,
      error: 'invalid-record'
    })
    expect(plan({ exclusions: [] })).toMatchObject({ ok: false, error: 'not-applicable' })
    expect(plan({ general: { paper: 'Napkin' } })).toMatchObject({
      ok: false,
      error: 'invalid-record'
    })
    expect(
      planBoardSetup(
        {
          board: parseKicadBoard(BOARD),
          settings: settings(),
          catalog: DRC_CATALOG,
          hasProject: false
        },
        { constraints: { minClearance: 0.1 } }
      )
    ).toMatchObject({ ok: false, error: 'no-project-file' })
  })

  test('general sets the page and the origins, with what they were', () => {
    const planned = plan({ general: { paper: 'A3', drillOrigin: { x: 100, y: 50 } } })
    if (!planned.ok) throw new Error(planned.detail)
    expect(planned.plan.board.paper).toBe('A3')
    expect(planned.plan.board.drillOrigin).toEqual({ x: 100_000_000, y: 50_000_000 })
    expect(planned.plan.before.general).toEqual({ paper: 'A4', drillOrigin: { x: 0, y: 0 } })
  })
})

describe('length-tuning patterns (router-behavior.md T6)', () => {
  test("read as KiCad's defaults where the project saves none, in the shape an update takes", () => {
    const record = boardSetupRecord(
      {
        board: parseKicadBoard(BOARD),
        settings: settings(),
        catalog: DRC_CATALOG,
        results: null,
        hasProject: true
      },
      ['tuningPatterns']
    )
    expect(record.tuningPatterns).toMatchObject({
      single: { spacing: 0.6, singleSided: false },
      pair: { spacing: 1 }
    })
  })

  test('an update lands on the project, its tuner alone, the amplitudes held in order', () => {
    const planned = plan({ tuningPatterns: { pair: { minAmplitude: 1.5 } } })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.project.tuning?.pair).toMatchObject({
      minAmplitude: 1.5,
      maxAmplitude: 1.5
    })
    expect(planned.plan.project.tuning?.single.minAmplitude).toBe(0.2)
    expect(planned.plan.changed.tuningPatterns).toEqual({ pair: ['minAmplitude'] })
    expect(planned.plan.project.design).toBeUndefined()
  })

  test('refuses a tuner or a field it does not know, and a value of the wrong kind', () => {
    expect(plan({ tuningPatterns: { diffPair: {} } })).toMatchObject({ error: 'not-applicable' })
    expect(plan({ tuningPatterns: { single: { amplitude: 1 } } })).toMatchObject({
      error: 'not-applicable'
    })
    expect(plan({ tuningPatterns: { skew: { singleSided: 1 } } })).toMatchObject({
      error: 'invalid-record'
    })
  })
})
