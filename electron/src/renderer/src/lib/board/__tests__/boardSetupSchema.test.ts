import { describe, expect, test } from 'vitest'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  type NetClassRow,
  addExtraSize,
  addNetClass,
  addNetClassPattern,
  applyBoardSetupEdit,
  balanceRuns,
  buildStackupRows,
  editExtraSize,
  editNetClass,
  importSchematicColors,
  editNetClassPattern,
  removeExtraSize,
  removeNetClass,
  removeNetClassPattern,
  NET_CLASS_COLUMNS,
  buildBoardSetupSections,
  settingRuns,
  stackupLayerPatch,
  COPPER_LAYER_COUNTS,
  CUSTOM_PRESET_ID,
  FINISH_SWATCHES,
  KIND_SWATCHES,
  layerSwatch,
  thicknessForWeight,
  weightForThickness,
  type BoardSetting,
  type BoardSetupModel,
  type BoardSetupSection
} from '../boardSetupSchema'
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  allStackupPresets,
  defaultStackupOf,
  deriveProfile,
  findProfile,
  matchesProfile,
  profileLabel
} from '../../manufacturingProfiles'
import {
  parseKicadBoard,
  serializeKicadBoard,
  setBoardStackupInAST,
  type KicadStackupLayer
} from '../../kicad/board'
import {
  DEFAULT_CLASS_NAME,
  DEFAULT_DESIGN_RULES,
  DEFAULT_TUNING_PATTERN_SETTINGS,
  makeNetClass
} from '../../kicad/project'
import { BOARD_SETUP_GLYPHS } from '../../boardSetupGlyphs'
import { DEFAULT_TEARDROP_SETTINGS } from '../teardrop/params'

const t = (key: string): string => key

const baseProfile = findProfile(DEFAULT_PROFILE_ID)!

/** A board whose stackup rows exist, so the table has something to build from. */
const layersOf = (spec = defaultStackupOf(baseProfile)): KicadStackupLayer[] => {
  const board = parseKicadBoard('(kicad_pcb (version 20240108) (setup))\n')
  setBoardStackupInAST(board, spec)
  return parseKicadBoard(serializeKicadBoard(board)).stackup?.layers ?? []
}

const model = (over: Partial<BoardSetupModel> = {}): BoardSetupModel => ({
  profiles: BUILT_IN_PROFILES,
  activeProfileId: baseProfile.id,
  edited: false,
  stackup: { ...defaultStackupOf(baseProfile) },
  layers: layersOf(),
  activeStackupId: baseProfile.stackups[0].id,
  stackupPresets: allStackupPresets().map((p) => ({ id: p.id, name: p.name })),
  rules: { ...baseProfile.rules },
  classes: [makeNetClass(DEFAULT_CLASS_NAME, baseProfile.defaults)],
  patterns: [],
  extraSizes: { tracks: [], vias: [] },
  tuning: structuredClone(DEFAULT_TUNING_PATTERN_SETTINGS),
  tuningProfiles: [],
  teardrops: structuredClone(DEFAULT_TEARDROP_SETTINGS),
  ...over
})

describe('manufacturing profiles', () => {
  test('every built-in has a self-consistent stackup', () => {
    // The board a profile describes must actually add up: copper + dielectric
    // equals the finished thickness, or the fab quote is for a different board.
    for (const preset of allStackupPresets()) {
      const board = parseKicadBoard('(kicad_pcb (version 20240108) (setup))\n')
      setBoardStackupInAST(board, preset.spec)
      const layers = parseKicadBoard(serializeKicadBoard(board)).stackup?.layers ?? []
      const copper = layers.filter((l) => l.type === 'copper')
      expect(copper.length).toBe(preset.spec.copperLayers)

      const total = layers
        .filter((l) => l.type === 'copper' || l.name.startsWith('dielectric'))
        .reduce((sum, l) => sum + (l.thickness ?? 0) / 1e6, 0)
      expect(total).toBeCloseTo(preset.spec.boardThickness, 6)
    }
  })

  test('labels read as "vendor · tier"', () => {
    expect(profileLabel(baseProfile)).toBe(`${baseProfile.vendor} · ${baseProfile.tier}`)
  })

  test('deriveProfile forks without mutating the built-in', () => {
    const derived = deriveProfile(baseProfile, { rules: { ...baseProfile.rules, minClearance: 9 } })
    expect(derived.builtIn).toBe(false)
    expect(derived.derivedFrom).toBe(baseProfile.id)
    expect(derived.rules.minClearance).toBe(9)
    // The shipped profile is untouched, and other fields carry over.
    expect(baseProfile.rules.minClearance).not.toBe(9)
    expect(derived.defaults).toEqual(baseProfile.defaults)
  })

  test('deriving twice keeps pointing at the original built-in', () => {
    const once = deriveProfile(baseProfile, {})
    const twice = deriveProfile(once, {})
    expect(twice.derivedFrom).toBe(baseProfile.id)
  })
})

/** The Constraints cards as the component lays them out — headers excluded. */
const constraintCards = (): BoardSetting[] =>
  buildBoardSetupSections(model(), t)
    .find((s) => s.id === 'constraints')!
    .settings.filter((setting) => !setting.isHeader)

describe('board setup schema', () => {
  test('builds nine sections that match where the data persists', () => {
    // stackup -> .kicad_pcb; constraints, tuning patterns, teardrops, profiles, net classes -> .kicad_pro.
    const sections = buildBoardSetupSections(model(), t)
    expect(sections.map((s) => s.id)).toEqual([
      'stackup',
      'constraints',
      'tuningPatterns',
      'teardrops',
      'tuningProfiles',
      'netClasses',
      'customRules',
      'rules',
      'exclusions'
    ])
  })

  test('the constraint configuration heads Constraints, not its own section', () => {
    // The profile dictates every constraint, only constrains the stackup, and
    // merely seeds the Default class — so it belongs inside Constraints.
    const sections = buildBoardSetupSections(model(), t)
    const constraints = sections.find((s) => s.id === 'constraints')!
    expect(constraints.settings[0].isHeader).toBe(true)
    expect(constraints.settings[0].key).toBe('profileId')
    // Net Classes has no header of its own — it is a table, not a preset.
    expect(sections.find((s) => s.id === 'netClasses')!.settings.some((x) => x.isHeader)).toBe(
      false
    )
    // Stackup's header is its catalog build, not the constraint set.
    expect(sections.find((s) => s.id === 'stackup')!.settings[0].key).toBe('stackupId')
  })

  test('constraint rows cover KiCad’s Constraints page, in its order', () => {
    const constraints = buildBoardSetupSections(model(), t).find((s) => s.id === 'constraints')!
    const rules = constraints.settings.filter((setting) => !setting.isHeader)
    // KiCad's Constraints page in full, in its order and its groupings — a
    // control KiCad offers and this page drops is a downgrade, not a
    // simplification, so the whole page is enumerated here on purpose.
    expect(rules.map((setting) => setting.key)).toEqual([
      'minClearance',
      'minTrackWidth',
      'minConnectionWidth',
      'minViaAnnularWidth',
      'minViaDiameter',
      'minCopperHoleClearance',
      'minCopperEdgeClearance',
      'minThroughHoleDiameter',
      'minHoleToHole',
      'minMicroviaDiameter',
      'minMicroviaDrill',
      'minSilkClearance',
      'minTextHeight',
      'minTextThickness',
      'maxError',
      'zonesAllowExternalFillets',
      'minResolvedSpokes',
      'useHeightForLengthCalcs'
    ])
    // The section covers every rule the model carries — no field editable in
    // theory but unreachable in the UI.
    expect(rules.length).toBe(Object.keys(DEFAULT_DESIGN_RULES).length)
    // Each row edits a real rule, so a renamed field cannot silently go inert.
    for (const setting of rules) expect(setting.key in DEFAULT_DESIGN_RULES).toBe(true)
    // Every row carries a diagram and drives a preview...
    for (const setting of rules) {
      expect(setting.glyph).toBeTruthy()
      expect(setting.preview).not.toBe('none')
    }
    // ...but NOT a subtitle. The audience are engineers; restating what a
    // clearance is would be noise, so the section description does that work.
    expect(rules.every((setting) => setting.blurb === undefined)).toBe(true)
  })

  test('a group label opens each run of constraints, none repeated', () => {
    // Eighteen cards in one flat column stop being scannable, so the section is
    // grouped the way KiCad groups it — and only the FIRST card of a run
    // carries the label, since the component renders a heading per `group`.
    const constraints = buildBoardSetupSections(model(), t).find((s) => s.id === 'constraints')!
    const groups = constraints.settings.map((setting) => setting.group).filter(Boolean)
    expect(groups).toEqual([
      'copper',
      'holes',
      'microvias',
      'silk',
      'arcs',
      'zones',
      'lengthTuning'
    ])
    // The first non-header card must open a group, else the run has no heading.
    expect(constraints.settings.find((s) => !s.isHeader)!.group).toBe('copper')
  })

  test('runs cut at every group boundary and cover every card exactly once', () => {
    const cards = constraintCards()
    const runs = settingRuns(cards)
    expect(runs.map((run) => run.group)).toEqual([
      'copper',
      'holes',
      'microvias',
      'silk',
      'arcs',
      'zones',
      'lengthTuning'
    ])
    // No card lost and none duplicated — a card missing from every run would
    // simply not render.
    expect(runs.flatMap((run) => run.indices)).toEqual(cards.map((_, i) => i))
  })

  test('columns split whole categories, in reading order', () => {
    // The layout promise: a category reads straight down one column. A run
    // broken across the boundary would have you reading up and over mid-
    // category, which is the thing this replaced.
    const [left, right] = balanceRuns(settingRuns(constraintCards()))
    expect(left.map((r) => r.group)).toEqual(['copper', 'holes'])
    expect(right.map((r) => r.group)).toEqual([
      'microvias',
      'silk',
      'arcs',
      'zones',
      'lengthTuning'
    ])
    // Order is preserved across the split, so column one then column two reads
    // the same sequence as the flat list.
    expect([...left, ...right].flatMap((r) => r.indices)).toEqual(
      constraintCards().map((_, i) => i)
    )
  })

  test('the two columns come out close to even', () => {
    const [left, right] = balanceRuns(settingRuns(constraintCards()))
    const cards = (runs: typeof left): number => runs.reduce((n, run) => n + run.indices.length, 0)
    // Nine and nine of eighteen. Weighting headings keeps the column with five
    // of them from running away; without it this splits 11/7.
    expect(cards(left)).toBe(9)
    expect(cards(right)).toBe(9)
  })

  test('a section with no cards has nothing to split', () => {
    // Net Classes is two tables and no cards at all, so the column machinery
    // must yield an empty layout rather than a column of nothing.
    const netClasses = buildBoardSetupSections(model(), t).find((s) => s.id === 'netClasses')!
    expect(netClasses.settings).toEqual([])
    expect(balanceRuns(settingRuns(netClasses.settings))).toEqual([[]])
  })

  test('sections carry no restated-the-obvious description', () => {
    // A pane titled "Stackup" does not need a line saying it is the stackup;
    // the header picker and the rows are the explanation.
    for (const section of buildBoardSetupSections(model(), t)) {
      expect('description' in section).toBe(false)
    }
  })

  test('header pickers title themselves and carry no subtitle', () => {
    const headers = buildBoardSetupSections(model(), t)
      .flatMap((s) => s.settings)
      .filter((setting) => setting.isHeader)
    expect(headers.map((h) => h.key)).toEqual(['stackupId', 'profileId'])
    expect(headers.every((h) => h.blurb === undefined)).toBe(true)
    expect(headers.every((h) => h.label.length > 0)).toBe(true)
  })

  test('no setting carries a subtitle: a label and its value say enough', () => {
    const withBlurb = buildBoardSetupSections(model(), t)
      .flatMap((s) => s.settings)
      .filter((setting) => setting.blurb !== undefined && !setting.isHeader)
      .map((setting) => setting.key)
    expect(withBlurb).toEqual([])
  })

  test('every setting names a glyph that actually exists', () => {
    const names = new Set(Object.keys(BOARD_SETUP_GLYPHS))
    for (const section of buildBoardSetupSections(
      model({ stackup: { ...defaultStackupOf(baseProfile), copperLayers: 4 } }),
      t
    )) {
      for (const setting of section.settings) {
        if (setting.glyph) expect(names.has(setting.glyph)).toBe(true)
      }
    }
  })

  test('the stackup section is a layer table, not cards', () => {
    const stackup = buildBoardSetupSections(model(), t).find((s) => s.id === 'stackup')!
    // Only the catalog picker and the two board-wide controls are cards.
    expect(stackup.settings.map((setting) => setting.key)).toEqual([
      'stackupId',
      'copperLayers',
      'copperFinish'
    ])
    expect(stackup.layers?.length).toBeGreaterThan(0)
    // The other two sections stay card-based.
    for (const other of buildBoardSetupSections(model(), t).filter((s) => s.id !== 'stackup')) {
      expect(other.layers).toBeUndefined()
    }
  })

  test('Custom is always offered, and shown when no profile is picked', () => {
    const profileOf = (m: BoardSetupModel): BoardSetting =>
      buildBoardSetupSections(m, t).find((s) => s.id === 'constraints')!.settings[0]

    expect(profileOf(model()).editor.options?.map((o) => o.value)).toContain(CUSTOM_PRESET_ID)

    const custom = profileOf(model({ activeProfileId: null }))
    const options = custom.editor.options ?? []
    expect(options[options.length - 1].value).toBe(CUSTOM_PRESET_ID)
    expect(custom.value).toBe(CUSTOM_PRESET_ID)
  })

  test('edits fold into the right half and mark the model edited', () => {
    const start = model()
    expect(start.edited).toBe(false)

    const stackup = applyBoardSetupEdit(start, 'stackup', 'copperFinish', 'ENIG')
    expect(stackup.stackup.copperFinish).toBe('ENIG')
    expect(stackup.edited).toBe(true)
    // Untouched halves are carried through unchanged.
    expect(stackup.rules).toEqual(start.rules)

    const rules = applyBoardSetupEdit(start, 'constraints', 'minClearance', 0.3)
    expect(rules.rules.minClearance).toBe(0.3)
    expect(rules.stackup).toEqual(start.stackup)

    // Net classes are edited through their own entry points, not this one.
    expect(applyBoardSetupEdit(start, 'netClasses', 'trackWidth', 0.35)).toBe(start)
  })

  test('copper layers snap to an offered count, never a free number', () => {
    // Boards are built in even counts up to KiCad's 32, so an odd or
    // out-of-range value lands on the nearest real one.
    const pick = (v: string | number): number =>
      applyBoardSetupEdit(model(), 'stackup', 'copperLayers', v).stackup.copperLayers
    expect(pick('4')).toBe(4)
    expect(pick(32)).toBe(32)
    expect(pick(7)).toBe(6)
    expect(pick(99)).toBe(32)
    expect(pick(0)).toBe(2)
    expect(COPPER_LAYER_COUNTS.every((n) => n % 2 === 0 && n >= 2 && n <= 32)).toBe(true)
  })

  test('unknown sections and keys are ignored rather than corrupting the model', () => {
    const start = model()
    expect(applyBoardSetupEdit(start, 'bogus', 'minClearance', 1)).toBe(start)
    expect(applyBoardSetupEdit(start, 'stackup', 'notAStackupField', 1)).toBe(start)
    expect(applyBoardSetupEdit(start, 'constraints', 'notARule', 1)).toBe(start)
    expect(applyBoardSetupEdit(start, 'routing', 'notADefault', 1)).toBe(start)
  })

  test('board thickness is derived from the layers, not an editable field', () => {
    // It was a field; it is now the sum of the stack, so the fold ignores it.
    const start = model()
    expect(applyBoardSetupEdit(start, 'stackup', 'boardThickness', 0.8)).toBe(start)
  })
})

describe('stackup layer table', () => {
  const rowsOf = (m = model()): NonNullable<BoardSetupSection['layers']> =>
    buildBoardSetupSections(m, t).find((s) => s.id === 'stackup')!.layers!

  test('rows carry only the cells that apply to their kind', () => {
    const rows = rowsOf()
    const copper = rows.find((r) => r.kind === 'copper')!
    const dielectric = rows.find((r) => r.kind === 'dielectric')!
    const silk = rows.find((r) => r.kind === 'silk')!

    // Copper is specified by weight and has no color or dielectric constants.
    expect(copper.cells.weight).not.toBeNull()
    expect(copper.cells.thickness).not.toBeNull()
    expect(copper.cells.color).toBeNull()
    expect(copper.cells.epsilonR).toBeNull()

    // A dielectric has material and constants, but no weight.
    expect(dielectric.cells.epsilonR).not.toBeNull()
    expect(dielectric.cells.material).not.toBeNull()
    expect(dielectric.cells.weight).toBeNull()

    // Silkscreen is an ink film: color only, no thickness.
    expect(silk.cells.color).not.toBeNull()
    expect(silk.cells.thickness).toBeNull()
  })

  test('a 4-layer build exposes every copper row independently', () => {
    const rows = rowsOf(model({ layers: layersOf(findProfile('jlcpcb-4l-1.6')!.stackups[0].spec) }))
    const copper = rows.filter((r) => r.kind === 'copper')
    expect(copper.map((r) => r.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
    // Each addresses its own layer index, so inner foil edits independently.
    expect(new Set(copper.map((r) => r.index)).size).toBe(4)
    expect(rows.filter((r) => r.kind === 'dielectric').length).toBe(3)
  })

  test('dielectric rows are titled for display, not shown raw', () => {
    const rows = rowsOf()
    const dielectric = rows.find((r) => r.kind === 'dielectric')!
    // KiCad stores them lower-case; the table and the diagram show a name.
    expect(dielectric.name).toBe('dielectric 1')
    expect(dielectric.label).toBe('Dielectric 1')
    // Board layers are already proper names and are left alone.
    const copper = rows.find((r) => r.kind === 'copper')!
    expect(copper.label).toBe(copper.name)
  })

  test('a layer with no color shows it as not specified, in the default finish', () => {
    const rows = buildStackupRows(
      [
        { name: 'F.SilkS', type: 'Top Silk Screen' },
        { name: 'B.SilkS', type: 'Bottom Silk Screen', color: 'White' }
      ] as never,
      (key) => key
    )
    const [front, back] = rows
    expect(front.cells.color!.value).toBe('')
    expect(front.cells.color!.editor.options?.[0]).toMatchObject({
      value: '',
      label: 'boardSetup.columns.colorUnsetSilk',
      color: '#d8d8d8'
    })
    // Once a finish is chosen there is nothing unspecified to offer.
    expect(back.cells.color!.editor.options?.some((o) => o.value === '')).toBe(false)
  })

  test('color options carry a swatch of the finish they name', () => {
    const rows = rowsOf()
    const mask = rows.find((r) => r.kind === 'mask')!
    const options = mask.cells.color!.editor.options ?? []
    expect(options.length).toBeGreaterThan(1)
    // Every option is drawable — a color picker with no colors is a word list.
    expect(options.every((o) => /^#[0-9a-f]{6}$/i.test(o.color ?? ''))).toBe(true)
    // And it is the cured color, not the CSS keyword: mask green is dark.
    expect(options.find((o) => o.value === 'Green')?.color).toBe('#1f6b3a')
  })

  test('a layer is drawn in its own color, falling back to its material', () => {
    const rows = rowsOf()
    // Mask carries a finish color, so that is what it draws in.
    const mask = rows.find((r) => r.kind === 'mask')!
    expect(mask.swatch).toBe(FINISH_SWATCHES.Black)
    // Copper has no color field; it draws as the material.
    const copper = rows.find((r) => r.kind === 'copper')!
    expect(copper.swatch).toBe(KIND_SWATCHES.copper)
  })

  test('changing a mask color repaints the row and the diagram', () => {
    // One resolved color drives the row tint, the swatch chip and the
    // cross-section band, so a color edit cannot update only the dropdown.
    expect(layerSwatch('mask', 'Purple')).toBe(FINISH_SWATCHES.Purple)
    expect(layerSwatch('mask', 'Purple')).not.toBe(layerSwatch('mask', 'Green'))
    // An unknown or absent color still resolves to something drawable.
    expect(layerSwatch('mask', 'Chartreuse')).toBe(KIND_SWATCHES.mask)
    expect(layerSwatch('silk')).toBe(KIND_SWATCHES.silk)
  })

  test('copper weight maps to the thickness the file stores', () => {
    expect(thicknessForWeight('1 oz')).toBeCloseTo(0.035, 6)
    expect(weightForThickness(0.0175)).toBe('0.5 oz')
    // A hand-entered thickness matches no catalog weight.
    expect(weightForThickness(0.042)).toBeNull()
    expect(stackupLayerPatch('weight', '2 oz')).toEqual({ thickness: mm(0.07) })
    expect(stackupLayerPatch('weight', 'nonsense')).toBeNull()
  })

  test('each cell folds onto the matching layer field', () => {
    expect(stackupLayerPatch('thickness', mm(1.2))).toEqual({ thickness: mm(1.2) })
    expect(stackupLayerPatch('type', 'prepreg')).toEqual({ type: 'prepreg' })
    expect(stackupLayerPatch('material', 'FR4')).toEqual({ material: 'FR4' })
    expect(stackupLayerPatch('epsilonR', 4.6)).toEqual({ epsilonR: 4.6 })
    expect(stackupLayerPatch('lossTangent', 0.018)).toEqual({ lossTangent: 0.018 })
    expect(stackupLayerPatch('color', 'Black')).toEqual({ color: 'Black' })
  })
})

describe('net classes', () => {
  /** A model with a custom class and a pattern routing nets into it. */
  const withHv = (): BoardSetupModel =>
    model({
      classes: [makeNetClass(DEFAULT_CLASS_NAME), makeNetClass('HV')],
      patterns: [
        { netClass: 'HV', pattern: '/HV_*' },
        { netClass: DEFAULT_CLASS_NAME, pattern: 'GND' }
      ]
    })

  test('the section is two tables and no cards', () => {
    const section = buildBoardSetupSections(withHv(), t).find((s) => s.id === 'netClasses')!
    expect(section.netClasses?.map((r) => r.name)).toEqual([DEFAULT_CLASS_NAME, 'HV'])
    expect(section.netClassPatterns).toHaveLength(2)
    expect(section.settings).toEqual([])
  })

  test('every row carries a cell for every editable column', () => {
    // A column with no cell behind it renders an input bound to nothing.
    const section = buildBoardSetupSections(withHv(), t).find((s) => s.id === 'netClasses')!
    for (const row of section.netClasses!) {
      expect(Object.keys(row.cells).sort()).toEqual([...NET_CLASS_COLUMNS].sort())
    }
  })

  test('Default cannot be renamed or removed', () => {
    // Every unassigned net falls back to Default BY NAME, so renaming it would
    // orphan them and removing it would leave them with no geometry at all.
    const start = withHv()
    const row = buildBoardSetupSections(start, t).find((s) => s.id === 'netClasses')!.netClasses![0]
    expect(row.nameCell.readonly).toBe(true)
    // ...and the table draws no remove button for it.
    expect(row.isDefault).toBe(true)
    expect(editNetClass(start, 0, 'name', 'Renamed')).toBe(start)
    expect(removeNetClass(start, 0)).toBe(start)
  })

  test("a class's color is set and cleared; Default's stays the layer's, as in KiCad", () => {
    const red = { r: 200, g: 40, b: 40, a: 1 }
    const colored = editNetClass(withHv(), 1, 'pcbColor', red)
    expect(colored.classes[1].pcbColor).toEqual(red)
    const rows = buildBoardSetupSections(colored, t).find((s) => s.id === 'netClasses')!.netClasses!
    expect(rows[1].colorCell.value).toEqual(red)
    expect(rows[0].colorCell.readonly).toBe(true)
    expect(editNetClass(colored, 1, 'pcbColor', null).classes[1].pcbColor).toBeUndefined()
    const start = withHv()
    expect(editNetClass(start, 0, 'pcbColor', red)).toBe(start)
  })

  test("Schematic Setup's columns set and clear a class's wire styling; import copies its color to the PCB", () => {
    let next = editNetClass(withHv(), 1, 'wireWidth', 0.3)
    next = editNetClass(next, 1, 'lineStyle', 'dash')
    next = editNetClass(next, 1, 'schematicColor', { r: 10, g: 20, b: 30, a: 1 })
    expect(next.classes[1]).toMatchObject({ wireWidth: 0.3, lineStyle: 'dash' })
    const row = buildBoardSetupSections(next, t).find((s) => s.id === 'netClasses')!.netClasses![1]
    expect(row.schematicCells.wireWidth.value).toBe(0.3)
    expect(row.schematicCells.lineStyle.value).toBe('dash')
    const cleared = editNetClass(editNetClass(next, 1, 'wireWidth', null), 1, 'lineStyle', '')
    expect(cleared.classes[1].wireWidth).toBeUndefined()
    expect(cleared.classes[1].lineStyle).toBeUndefined()
    expect(importSchematicColors(next).classes[1].pcbColor).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    const plain = withHv()
    expect(importSchematicColors(plain)).toBe(plain)
  })

  test("an empty schematic cell shows what it inherits: Default's, else KiCad's own", () => {
    const rowsOf = (model: ReturnType<typeof withHv>): NetClassRow[] =>
      buildBoardSetupSections(model, t).find((s) => s.id === 'netClasses')!.netClasses!
    const plain = rowsOf(withHv())
    expect(plain[0].schematicCells.wireWidth.editor.placeholderValue).toBeCloseTo(0.1524)
    expect(plain[1].schematicCells.busWidth.editor.placeholderValue).toBeCloseTo(0.3048)
    expect(plain[1].schematicCells.lineStyle.editor.options![0]).toMatchObject({
      value: '',
      label: 'Solid'
    })
    const styled = rowsOf(
      editNetClass(editNetClass(withHv(), 0, 'wireWidth', 0.25), 0, 'lineStyle', 'dot')
    )
    expect(styled[1].schematicCells.wireWidth.editor.placeholderValue).toBe(0.25)
    expect(styled[1].schematicCells.lineStyle.editor.options![0].label).toBe('Dot')
  })

  test('renaming a class carries its patterns with it', () => {
    // A rename that left the patterns behind would silently unassign every net
    // the class routed — the board would still build, just wrong.
    const next = editNetClass(withHv(), 1, 'name', 'HighVoltage')
    expect(next.classes[1].name).toBe('HighVoltage')
    expect(next.patterns[0]).toEqual({ netClass: 'HighVoltage', pattern: '/HV_*' })
    // The unrelated pattern is untouched.
    expect(next.patterns[1]).toEqual({ netClass: DEFAULT_CLASS_NAME, pattern: 'GND' })
  })

  test('names stay unique, since a pattern addresses a class by name', () => {
    const next = editNetClass(withHv(), 1, 'name', DEFAULT_CLASS_NAME)
    expect(next.classes[1].name).toBe('Default 2')
    // Adding twice does not produce two classes with one name either.
    const twice = addNetClass(addNetClass(withHv(), 'Power'), 'Power')
    expect(twice.classes.map((c) => c.name)).toEqual([DEFAULT_CLASS_NAME, 'HV', 'Power', 'Power 2'])
  })

  test('a blank or unchanged name is not an edit', () => {
    const start = withHv()
    expect(editNetClass(start, 1, 'name', '   ')).toBe(start)
    expect(editNetClass(start, 1, 'name', 'HV')).toBe(start)
    expect(editNetClass(start, 9, 'name', 'Nope')).toBe(start)
  })

  test('a new class is seeded from Default, not from zero', () => {
    // A class of blank geometry would route 0mm tracks; seeding from Default
    // means a new class starts manufacturable and is then narrowed.
    const start = model({
      classes: [
        makeNetClass(DEFAULT_CLASS_NAME, {
          trackWidth: 0.3,
          clearance: 0.25,
          viaDiameter: 0.7,
          viaDrill: 0.35
        })
      ]
    })
    const next = addNetClass(start, 'Power')
    expect(next.classes[1].trackWidth).toBe(0.3)
    expect(next.classes[1].viaDrill).toBe(0.35)
  })

  test('removing a class takes its patterns with it', () => {
    // A pattern naming a class that no longer exists is config KiCad cannot
    // honor, so it goes with the class rather than being left in the file.
    const next = removeNetClass(withHv(), 1)
    expect(next.classes.map((c) => c.name)).toEqual([DEFAULT_CLASS_NAME])
    expect(next.patterns).toEqual([{ netClass: DEFAULT_CLASS_NAME, pattern: 'GND' }])
  })

  test('a dangling pattern is flagged and keeps pointing where it pointed', () => {
    // Snapping it to another class would silently reassign nets; the row is
    // marked instead so the user decides.
    const stale = model({
      classes: [makeNetClass(DEFAULT_CLASS_NAME)],
      patterns: [{ netClass: 'Gone', pattern: 'GND' }]
    })
    const row = buildBoardSetupSections(stale, t).find((s) => s.id === 'netClasses')!
      .netClassPatterns![0]
    expect(row.dangling).toBe(true)
    expect(row.classCell.value).toBe('Gone')
    // The missing class is offered so the select can display it at all.
    expect(row.classCell.editor.options?.map((o) => o.value)).toContain('Gone')
  })

  test('patterns add, edit and remove', () => {
    const added = addNetClassPattern(withHv())
    expect(added.patterns).toHaveLength(3)
    // A new row aims at a real class, not at nothing.
    expect(added.classes.map((c) => c.name)).toContain(added.patterns[2].netClass)

    const edited = editNetClassPattern(added, 2, 'pattern', '/PWR*')
    expect(edited.patterns[2].pattern).toBe('/PWR*')
    expect(removeNetClassPattern(edited, 2).patterns).toHaveLength(2)
    expect(removeNetClassPattern(edited, 9)).toBe(edited)
  })

  test('a profile is matched on Default alone, however many classes exist', () => {
    // A fab tells you what it can hold, not how many classes your design wants,
    // so adding a 90-ohm class must not make the board stop matching its fab.
    const seeded = model({ classes: [makeNetClass(DEFAULT_CLASS_NAME, baseProfile.defaults)] })
    expect(matchesProfile(baseProfile, seeded)).toBe(true)

    const plusClass = addNetClass(seeded, 'HV')
    expect(matchesProfile(baseProfile, plusClass)).toBe(true)

    // Narrowing the ADDED class still leaves the board on its profile...
    const narrowed = editNetClass(plusClass, 1, 'trackWidth', 0.1)
    expect(matchesProfile(baseProfile, narrowed)).toBe(true)
    // ...while changing DEFAULT is what takes it off, since that is the class
    // the profile actually seeded.
    expect(matchesProfile(baseProfile, editNetClass(plusClass, 0, 'trackWidth', 0.1))).toBe(false)
  })
})

describe('extra sizes (router-behavior.md S4)', () => {
  test('rows per size, a via with its diameter and drill', () => {
    const section = buildBoardSetupSections(
      model({ extraSizes: { tracks: [0.2, 0.5], vias: [{ diameter: 0.8, drill: 0.4 }] } }),
      t
    ).find((s) => s.id === 'netClasses')!
    expect(section.extraTracks?.map((r) => r.cells[0].value)).toEqual([0.2, 0.5])
    expect(section.extraVias?.[0].cells.map((c) => c.value)).toEqual([0.8, 0.4])
  })

  test('add seeds from Default, edit keeps a via drillable, remove drops the row', () => {
    let m = addExtraSize(model(), 'track')
    m = addExtraSize(m, 'via')
    const base = m.classes[0]
    expect(m.extraSizes.tracks).toEqual([base.trackWidth])
    expect(m.extraSizes.vias).toEqual([{ diameter: base.viaDiameter, drill: base.viaDrill }])
    m = editExtraSize(m, 'track', 0, 'width', 0.3)
    expect(m.extraSizes.tracks).toEqual([0.3])
    expect(editExtraSize(m, 'via', 0, 'drill', 5)).toBe(m)
    expect(editExtraSize(m, 'track', 0, 'width', 0)).toBe(m)
    expect(removeExtraSize(m, 'track', 0).extraSizes.tracks).toEqual([])
  })
})

describe('length-tuning patterns (router-behavior.md T6)', () => {
  const section = (m = model()): BoardSetupSection =>
    buildBoardSetupSections(m, t).find((s) => s.id === 'tuningPatterns')!

  test("each tuner is a group of KiCad's five defaults, keyed mode.field", () => {
    const settings = section().settings
    expect(settings.filter((s) => s.group).map((s) => s.group)).toEqual([
      'tuneSingle',
      'tunePair',
      'tuneSkew'
    ])
    expect(settings.slice(0, 5).map((s) => s.key)).toEqual([
      'single.minAmplitude',
      'single.maxAmplitude',
      'single.spacing',
      'single.cornerRadiusPercent',
      'single.singleSided'
    ])
    // A pair's spacing defaults wider, as KiCad's does.
    expect(settings.find((s) => s.key === 'pair.spacing')?.value).toBe(1)
  })

  test('an edit lands on its tuner alone, the amplitudes held in order', () => {
    const m = model()
    const wider = applyBoardSetupEdit(m, 'tuningPatterns', 'skew.maxAmplitude', 2)
    expect(wider.tuning.skew.maxAmplitude).toBe(2)
    expect(wider.tuning.single).toBe(m.tuning.single)
    const raised = applyBoardSetupEdit(m, 'tuningPatterns', 'single.minAmplitude', 3)
    expect(raised.tuning.single).toMatchObject({ minAmplitude: 3, maxAmplitude: 3 })
    const sided = applyBoardSetupEdit(m, 'tuningPatterns', 'pair.singleSided', true)
    expect(sided.tuning.pair.singleSided).toBe(true)
    expect(
      applyBoardSetupEdit(m, 'tuningPatterns', 'single.cornerRadiusPercent', 140).tuning.single
        .cornerRadiusPercent
    ).toBe(100)
  })
})
