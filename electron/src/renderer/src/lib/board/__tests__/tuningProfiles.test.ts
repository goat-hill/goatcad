import { describe, expect, test } from 'vitest'
import {
  addProfileLayer,
  addTuningProfile,
  applyLayerSolve,
  editProfileLayer,
  editTuningProfile,
  profileRowReadout,
  removeTuningProfile,
  solveProfileRow,
  type TuningProfileModel
} from '../tuningProfiles'
import { copperNamesFor, editNetClass } from '../boardSetupSchema'
import { planBoardSetup } from '../boardSetup'
import { parseKicadBoard } from '../../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  makeNetClass,
  tuningSettingsOf,
  type BoardDesignSettings
} from '../../kicad/project'
import { DRC_CATALOG } from '../drcCatalog'
import { solverStackupOf } from '../impedance'

const FOUR = copperNamesFor(4)

const empty = (): TuningProfileModel & { patterns: []; edited: boolean } => ({
  tuningProfiles: [],
  classes: [...DEFAULT_NET_CLASSES, makeNetClass('USB')],
  patterns: [],
  edited: false
})

describe('tuning profiles, edited', () => {
  test('copper is named top to bottom for its count', () => {
    expect(FOUR).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
    expect(copperNamesFor(2)).toEqual(['F.Cu', 'B.Cu'])
  })

  test("rows are added as KiCad's OnAddTrackRow adds them, wrapping past the bottom", () => {
    let model = addTuningProfile(empty(), 'Profile')
    for (let i = 0; i < 5; i++) model = addProfileLayer(model, 0, FOUR)
    expect(
      model.tuningProfiles[0].layers.map((l) => [l.layer, l.topReference, l.bottomReference])
    ).toEqual([
      ['F.Cu', '', 'In1.Cu'],
      ['In1.Cu', 'F.Cu', 'In2.Cu'],
      ['In2.Cu', 'In1.Cu', 'B.Cu'],
      ['B.Cu', 'In2.Cu', ''],
      ['F.Cu', '', 'In1.Cu']
    ])
  })

  test('a layer appears once per profile; a delay is typed in ps/mm and kept in as/mm', () => {
    let model = addTuningProfile(empty(), 'P')
    model = addProfileLayer(addProfileLayer(model, 0, FOUR), 0, FOUR)
    expect(editProfileLayer(model, 0, 1, 'layer', 'F.Cu')).toBe(model)
    model = editProfileLayer(model, 0, 0, 'delay', 6.1)
    expect(model.tuningProfiles[0].layers[0].delay).toBe(6_100_000)
  })

  test('a rename carries the classes that name it; a removal clears them', () => {
    let model = addTuningProfile(empty(), 'USB_90')
    model = editNetClass(model, 1, 'tuningProfile', 'USB_90')
    model = editTuningProfile(model, 0, 'name', 'USB_HS')
    expect(model.classes[1].tuningProfile).toBe('USB_HS')
    model = removeTuningProfile(model, 0)
    expect(model.tuningProfiles).toEqual([])
    expect(model.classes[1]).not.toHaveProperty('tuningProfile')
  })

  test('a name is unique, and a solve writes only the cells it was given', () => {
    let model = addTuningProfile(addTuningProfile(empty(), 'P'), 'P')
    expect(model.tuningProfiles.map((p) => p.name)).toEqual(['P', 'P 2'])
    model = addProfileLayer(model, 0, FOUR)
    model = editProfileLayer(model, 0, 0, 'gap', 0.15)
    model = applyLayerSolve(model, 0, 0, { width: 0.2, delay: 5_900_000 })
    expect(model.tuningProfiles[0].layers[0]).toMatchObject({
      width: 0.2,
      gap: 0.15,
      delay: 5_900_000
    })
  })
})

describe('tuning profiles, through board_update_setup', () => {
  const BOARD = `(kicad_pcb (version 20240108) (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (setup) (net 0 ""))`
  const settings = (): BoardDesignSettings => ({
    rules: { ...DEFAULT_DESIGN_RULES },
    classes: [...DEFAULT_NET_CLASSES, makeNetClass('USB')],
    patterns: [],
    assignments: [],
    severities: {}
  })
  const plan = (
    changes: Record<string, unknown>,
    s = settings()
  ): ReturnType<typeof planBoardSetup> =>
    planBoardSetup(
      { board: parseKicadBoard(BOARD), settings: s, catalog: DRC_CATALOG, hasProject: true },
      changes
    )

  test('a profile and the class that names it land in one update', () => {
    const result = plan({
      tuningProfiles: {
        upsert: [
          {
            name: 'USB_90',
            type: 'differential',
            targetImpedance: 90,
            layers: [{ layer: 'F.Cu', bottomReference: 'B.Cu', width: 0.3, gap: 0.15, delay: 6 }]
          }
        ]
      },
      netClasses: { upsert: [{ name: 'USB', tuningProfile: 'USB_90' }] }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.project.tuningProfiles?.[0]).toMatchObject({
      name: 'USB_90',
      differential: true,
      layers: [{ layer: 'F.Cu', bottomReference: 'B.Cu', width: 0.3, gap: 0.15, delay: 6e6 }]
    })
    expect(result.plan.project.design?.classes.find((c) => c.name === 'USB')?.tuningProfile).toBe(
      'USB_90'
    )
  })

  test('a layer the board lacks, or a class naming no profile, is refused with what exists', () => {
    const bad = plan({
      tuningProfiles: { upsert: [{ name: 'P', layers: [{ layer: 'In1.Cu' }] }] }
    })
    expect(bad).toMatchObject({ ok: false, candidates: ['F.Cu', 'B.Cu'] })
    const dangling = plan({ netClasses: { upsert: [{ name: 'USB', tuningProfile: 'Nope' }] } })
    expect(dangling).toMatchObject({ ok: false, error: 'invalid-record' })
  })

  test('a removed profile clears the class that named it, and the classes are written', () => {
    const s = settings()
    s.classes = s.classes.map((c) => (c.name === 'USB' ? { ...c, tuningProfile: 'USB_90' } : c))
    s.tuning = tuningSettingsOf(
      [
        {
          name: 'USB_90',
          differential: true,
          targetImpedance: 90,
          timeDomain: false,
          layers: [],
          viaDelay: 0,
          overrides: []
        }
      ],
      { USB: 'USB_90' }
    )
    const result = plan({ tuningProfiles: { remove: ['USB_90'] } }, s)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.project.tuningProfiles).toEqual([])
    expect(result.plan.project.design?.classes.find((c) => c.name === 'USB')).not.toHaveProperty(
      'tuningProfile'
    )
  })
})

describe('a profile row, solved', () => {
  const stackup = solverStackupOf(
    parseKicadBoard(`(kicad_pcb (version 20240108) (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (setup) (net 0 ""))`)
  )

  test('Solve fills the width for the target, and the readout reads it back at the target', () => {
    let model = addTuningProfile(empty(), 'USB')
    model = editTuningProfile(model, 0, 'differential', 'differential')
    model = editTuningProfile(model, 0, 'targetImpedance', 90)
    model = addProfileLayer(model, 0, copperNamesFor(2))
    model = editProfileLayer(model, 0, 0, 'gap', 0.2)
    const [profile] = model.tuningProfiles
    const solved = solveProfileRow(stackup, profile, profile.layers[0])
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    model = applyLayerSolve(model, 0, 0, solved.solve)
    const row = model.tuningProfiles[0].layers[0]
    expect(row.width).toBeGreaterThan(0)
    expect(row.delay).toBeGreaterThan(0)
    const read = profileRowReadout(stackup, model.tuningProfiles[0], row)
    expect(read).toMatchObject({ ok: true })
    if (read?.ok) expect(read.ohms).toBeCloseTo(90, 0)
  })

  test("a pair with no gap is refused with KiCad's reason, and an empty row reads nothing", () => {
    let model = addTuningProfile(empty(), 'USB')
    model = editTuningProfile(model, 0, 'differential', 'differential')
    model = editTuningProfile(model, 0, 'targetImpedance', 90)
    model = addProfileLayer(model, 0, copperNamesFor(2))
    const [profile] = model.tuningProfiles
    expect(solveProfileRow(stackup, profile, profile.layers[0])).toEqual({
      ok: false,
      error: 'gap-required'
    })
    expect(profileRowReadout(stackup, profile, profile.layers[0])).toBeNull()
  })
})

describe('an agent solves a profile', () => {
  test('solve: true fills each layer for the target, as Solve all does', () => {
    const result = planBoardSetup(
      {
        board: parseKicadBoard(`(kicad_pcb (version 20240108) (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (setup) (net 0 ""))`),
        settings: {
          rules: { ...DEFAULT_DESIGN_RULES },
          classes: [...DEFAULT_NET_CLASSES],
          patterns: [],
          assignments: [],
          severities: {}
        },
        catalog: DRC_CATALOG,
        hasProject: true
      },
      {
        tuningProfiles: {
          upsert: [
            {
              name: 'RF',
              targetImpedance: 50,
              layers: [{ layer: 'F.Cu', bottomReference: 'B.Cu' }],
              solve: true
            }
          ]
        }
      }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = result.plan.project.tuningProfiles![0].layers
    expect(row.width).toBeGreaterThan(2)
    expect(row.delay).toBeGreaterThan(0)
  })
})
