import { describe, expect, test } from 'vitest'
import { reactive } from 'vue'
import { mmToNm, spacingToMm } from '../coordinates'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_CLASS_NAME,
  DEFAULT_NET_CLASSES,
  DEFAULT_ROUTING_DEFAULTS,
  defaultNetClass,
  makeNetClass,
  type NetClass,
  matchesNetPattern,
  netClassForNet,
  extractBomSettings,
  extractConnectionGrid,
  extractDesignSettings,
  extractRuleSeverities,
  patchBomSettings,
  patchDesignSettings,
  patchRuleSeverities,
  patchTuningProfiles,
  tuningSettingsOf,
  type TuningProfile,
  type BomSettings,
  type BoardDesignSettings,
  type DesignRules,
  migrateProjectFile,
  patchBoardSetupChoice
} from '../project'

const projectSource = `{
  "meta": { "version": 1 },
  "sheets": [ ["power_supply.kicad_sch", "Power Supply Sheet"] ],
  "pcb": "power_supply.kicad_pcb"
}`

const settings: BomSettings = {
  fields_ordered: [
    { name: 'Reference', label: 'Reference', show: true, group_by: false },
    { name: 'Value', label: 'Value', show: true, group_by: true },
    { name: '${DNP}', label: 'DNP', show: true, group_by: false }
  ],
  group_symbols: true,
  sort_field: 'Reference',
  sort_asc: true,
  filter_string: '',
  exclude_dnp: false
}

describe('KiCad project bom_settings', () => {
  test('extracts nothing from a project without schematic settings', () => {
    expect(extractBomSettings(projectSource)).toBeNull()
  })

  test('returns null for malformed JSON instead of throwing', () => {
    expect(extractBomSettings('(kicad_pro not json)')).toBeNull()
    expect(patchBomSettings('(kicad_pro not json)', settings)).toBeNull()
    expect(extractBomSettings('[1, 2, 3]')).toBeNull()
  })

  test('patch creates the schematic key and preserves sibling keys and order', () => {
    const patched = patchBomSettings(projectSource, settings)
    expect(patched).not.toBeNull()
    const root = JSON.parse(patched!)
    expect(root.meta).toEqual({ version: 1 })
    expect(root.sheets).toEqual([['power_supply.kicad_sch', 'Power Supply Sheet']])
    expect(root.pcb).toBe('power_supply.kicad_pcb')
    expect(Object.keys(root)).toEqual(['meta', 'sheets', 'pcb', 'schematic'])
    expect(root.schematic.bom_settings.group_symbols).toBe(true)
  })

  test('patch → extract round-trips and is idempotent', () => {
    const patched = patchBomSettings(projectSource, settings)!
    expect(extractBomSettings(patched)).toEqual(settings)
    expect(patchBomSettings(patched, settings)).toBe(patched)
  })

  test('patch preserves unrelated schematic sub-keys', () => {
    const withSchematic = JSON.stringify({
      meta: { version: 1 },
      schematic: { annotate_start_num: 0, drawing: { dashed_lines_dash_length_ratio: 12 } }
    })
    const root = JSON.parse(patchBomSettings(withSchematic, settings)!)
    expect(root.schematic.annotate_start_num).toBe(0)
    expect(root.schematic.drawing.dashed_lines_dash_length_ratio).toBe(12)
    expect(root.schematic.bom_settings.fields_ordered).toHaveLength(3)
  })

  test('extract tolerates partial field entries and fills defaults', () => {
    const text = JSON.stringify({
      schematic: {
        bom_settings: {
          fields_ordered: [{ name: 'MPN' }, { bogus: true }, 'not-an-object'],
          sort_field: 42
        }
      }
    })
    const extracted = extractBomSettings(text)
    expect(extracted).toEqual({
      fields_ordered: [{ name: 'MPN', label: 'MPN', show: true, group_by: false }],
      group_symbols: false,
      sort_field: 'Reference',
      sort_asc: true,
      filter_string: '',
      exclude_dnp: false
    })
  })
})

describe('KiCad project design settings', () => {
  const designSettings: BoardDesignSettings = {
    rules: {
      ...DEFAULT_DESIGN_RULES,
      minClearance: 0.15,
      minTrackWidth: 0.15,
      minViaDiameter: 0.45,
      minThroughHoleDiameter: 0.25,
      minHoleToHole: 0.4,
      minViaAnnularWidth: 0.1,
      minCopperEdgeClearance: 0.25
    },
    classes: [
      makeNetClass(DEFAULT_CLASS_NAME, {
        trackWidth: 0.25,
        clearance: 0.2,
        viaDiameter: 0.6,
        viaDrill: 0.3
      })
    ],
    patterns: [],
    assignments: []
  }

  /** The fixture with a few rules overridden — for pinning one field's behavior. */
  const withRules = (over: Partial<DesignRules>): BoardDesignSettings => ({
    ...designSettings,
    rules: { ...designSettings.rules, ...over }
  })

  test('returns null for malformed JSON instead of throwing', () => {
    expect(extractDesignSettings('(kicad_pro not json)')).toBeNull()
    expect(patchDesignSettings('(kicad_pro not json)', designSettings)).toBeNull()
    expect(extractDesignSettings('[1, 2, 3]')).toBeNull()
  })

  test('a project with no rules yields the built-in defaults', () => {
    // KiCad falls back to compiled-in defaults rather than failing; so do we.
    expect(extractDesignSettings(projectSource)).toEqual({
      rules: DEFAULT_DESIGN_RULES,
      classes: DEFAULT_NET_CLASSES,
      patterns: [],
      assignments: [],
      severities: {},
      exclusions: []
    })
  })

  test('reads every class, Default first, and its assignment patterns', () => {
    const text = JSON.stringify({
      board: { design_settings: { rules: { min_clearance: 0.13, min_track_width: 0.127 } } },
      net_settings: {
        classes: [
          { name: 'HV', clearance: 1.5, track_width: 0.8 },
          { name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.8, via_drill: 0.4 }
        ],
        netclass_patterns: [{ netclass: 'HV', pattern: '/HV_*' }],
        netclass_assignments: { '/HV_OUT': ['HV'], '/AUX': ['HV', 'Ghost'] }
      }
    })
    const extracted = extractDesignSettings(text)
    expect(extracted?.rules.minClearance).toBe(0.13)
    expect(extracted?.assignments).toEqual([
      { net: '/HV_OUT', netClass: 'HV' },
      { net: '/AUX', netClass: 'HV' },
      { net: '/AUX', netClass: 'Ghost' }
    ])
    // Keys the file omits fall back rather than reading as 0.
    expect(extracted?.rules.minViaDiameter).toBe(DEFAULT_DESIGN_RULES.minViaDiameter)

    // Default is hoisted to the front however the file ordered the list — the
    // rest of the app treats index 0 as the fallback class.
    expect(extracted?.classes.map((c) => c.name)).toEqual(['Default', 'HV'])
    expect(extracted?.classes[0].trackWidth).toBe(0.25)
    expect(extracted?.classes[0].viaDrill).toBe(0.4)
    // A custom class keeps its own geometry and leaves the rest to Default,
    // as KiCad does: it shows Default's value, and says the field is unset.
    expect(extracted?.classes[1].clearance).toBe(1.5)
    expect(extracted?.classes[1].viaDiameter).toBe(0.8)
    expect(extracted?.classes[1].unset).toEqual([
      'viaDiameter',
      'viaDrill',
      'microviaDiameter',
      'microviaDrill',
      'diffPairWidth',
      'diffPairGap'
    ])
    expect(extracted?.patterns).toEqual([{ netClass: 'HV', pattern: '/HV_*' }])
  })

  test('a project with classes but no Default gets one synthesised', () => {
    // Every unassigned net routes with Default, so the app treats it as always
    // present — a hand-edited file that dropped it must not break the editor.
    const text = JSON.stringify({
      net_settings: { classes: [{ name: 'HV', clearance: 1.5 }] }
    })
    const extracted = extractDesignSettings(text)
    expect(extracted?.classes.map((c) => c.name)).toEqual(['Default', 'HV'])
  })

  test('patterns naming no class are read, not silently dropped', () => {
    // The UI flags these so the user can fix them; discarding them here would
    // lose the assignment the moment the file was opened.
    const text = JSON.stringify({
      net_settings: {
        classes: [{ name: 'Default' }],
        netclass_patterns: [
          { netclass: 'Gone', pattern: 'GND' },
          { netclass: '', pattern: 'bad' },
          { pattern: 'alsobad' }
        ]
      }
    })
    // The two malformed entries carry no class at all and are unusable; the
    // dangling-but-complete one survives.
    expect(extractDesignSettings(text)?.patterns).toEqual([{ netClass: 'Gone', pattern: 'GND' }])
  })

  test('patch creates both keys and preserves sibling keys and order', () => {
    const patched = patchDesignSettings(projectSource, designSettings)
    expect(patched).not.toBeNull()
    const root = JSON.parse(patched!)
    expect(root.meta).toEqual({ version: 1 })
    expect(root.sheets).toEqual([['power_supply.kicad_sch', 'Power Supply Sheet']])
    expect(root.pcb).toBe('power_supply.kicad_pcb')
    expect(Object.keys(root)).toEqual(['meta', 'sheets', 'pcb', 'board', 'net_settings'])
    expect(root.board.design_settings.rules.min_clearance).toBe(0.15)
    // A class is written whole — every field the editor owns, plus the priority
    // KiCad needs to resolve pattern precedence.
    expect(root.net_settings.classes).toEqual([
      {
        name: 'Default',
        clearance: 0.2,
        track_width: 0.25,
        via_diameter: 0.6,
        via_drill: 0.3,
        microvia_diameter: 0.3,
        microvia_drill: 0.1,
        diff_pair_width: 0.2,
        diff_pair_gap: 0.25,
        priority: 2147483647
      }
    ])
  })

  test('patch → extract round-trips and is idempotent', () => {
    const patched = patchDesignSettings(projectSource, designSettings)!
    expect(extractDesignSettings(patched)).toEqual({
      ...designSettings,
      classes: [{ ...designSettings.classes[0], priority: 2147483647 }],
      severities: {},
      exclusions: []
    })
    expect(patchDesignSettings(patched, designSettings)).toBe(patched)
  })

  test('zone external fillets round-trip from beside `rules`, not inside it', () => {
    // KiCad keeps this one constraint a level up from the rest. Writing it into
    // `rules` would round-trip fine through our own reader and be silently
    // ignored by KiCad — so pin the location, not just the value.
    const patched = patchDesignSettings(
      projectSource,
      withRules({ zonesAllowExternalFillets: true })
    )!
    const root = JSON.parse(patched)
    expect(root.board.design_settings.zones_allow_external_fillets).toBe(true)
    expect('zones_allow_external_fillets' in root.board.design_settings.rules).toBe(false)
    expect(extractDesignSettings(patched)?.rules.zonesAllowExternalFillets).toBe(true)
  })

  test('booleans survive as booleans, not 0/1', () => {
    const patched = patchDesignSettings(
      projectSource,
      withRules({ useHeightForLengthCalcs: false, zonesAllowExternalFillets: true })
    )!
    const rules = JSON.parse(patched).board.design_settings.rules
    expect(rules.use_height_for_length_calcs).toBe(false)
    expect(typeof rules.use_height_for_length_calcs).toBe('boolean')
    expect(typeof JSON.parse(patched).board.design_settings.zones_allow_external_fillets).toBe(
      'boolean'
    )
  })

  test('patch preserves unrelated design-settings and net-class keys', () => {
    const text = JSON.stringify({
      board: {
        design_settings: {
          defaults: { silk_line_width: 0.1 },
          // solder_mask_to_copper_clearance is a real KiCad rule GoatCAD does
          // not surface (it belongs to the solder-mask page, not Constraints) —
          // exactly the kind of key the patch must carry through untouched.
          rules: { solder_mask_to_copper_clearance: 0.05, min_clearance: 0.9 },
          track_widths: [0.2, 0.4]
        },
        layer_presets: []
      },
      net_settings: {
        classes: [
          { name: 'HV', clearance: 1.5 },
          { name: 'Default', clearance: 0.9, bus_width: 12, pcb_color: 'rgba(0, 0, 0, 0.000)' }
        ],
        meta: { version: 3 }
      }
    })
    const root = JSON.parse(patchDesignSettings(text, designSettings)!)

    // Untouched neighbours survive at every level.
    expect(root.board.layer_presets).toEqual([])
    expect(root.board.design_settings.defaults.silk_line_width).toBe(0.1)
    expect(root.board.design_settings.track_widths).toEqual([0.2, 0.4])
    expect(root.board.design_settings.rules.solder_mask_to_copper_clearance).toBe(0.05)
    expect(root.net_settings.meta).toEqual({ version: 3 })

    // Managed values are overwritten.
    expect(root.board.design_settings.rules.min_clearance).toBe(0.15)

    // The class list is written as GIVEN — the editor owns it, so a class the
    // model no longer holds is gone. (The host always writes a list it just
    // read, so this only drops what the user actually removed.)
    expect(root.net_settings.classes.map((c: { name: string }) => c.name)).toEqual(['Default'])

    // Within a class it DOES know, every key it does not own survives: the
    // schematic-side bus width and the PCB color are still there.
    const written = root.net_settings.classes[0]
    expect(written.bus_width).toBe(12)
    expect(written.pcb_color).toBe('rgba(0, 0, 0, 0.000)')
    expect(written.clearance).toBe(0.2)
    expect(written.track_width).toBe(0.25)
    // Default is parked at INT_MAX so every custom class outranks it.
    expect(written.priority).toBe(2147483647)
  })

  test('a class the editor did not know about keeps nothing but is written whole', () => {
    // Adding a class in the UI writes a complete entry — no half-populated
    // class that KiCad would then fill with its own idea of the defaults.
    const settings: BoardDesignSettings = {
      ...designSettings,
      classes: [...designSettings.classes, makeNetClass('HV')],
      patterns: [{ netClass: 'HV', pattern: '/HV_*' }]
    }
    const root = JSON.parse(patchDesignSettings(projectSource, settings)!)
    const hv = root.net_settings.classes[1]
    expect(hv.name).toBe('HV')
    expect(hv.track_width).toBe(DEFAULT_ROUTING_DEFAULTS.trackWidth)
    expect(hv.microvia_drill).toBe(0.1)
    // A new class outranks Default rather than tying with it.
    expect(hv.priority).toBeLessThan(2147483647)
    expect(root.net_settings.netclass_patterns).toEqual([{ netclass: 'HV', pattern: '/HV_*' }])
  })

  test('an existing class keeps the priority the file gave it', () => {
    // Priority decides which pattern wins. Renumbering on every save would
    // silently reorder a user's assignment precedence.
    const text = JSON.stringify({
      net_settings: {
        classes: [
          { name: 'Default', priority: 2147483647 },
          { name: 'HV', priority: 3, clearance: 1.5 }
        ]
      }
    })
    const settings: BoardDesignSettings = {
      ...designSettings,
      classes: [...designSettings.classes, makeNetClass('HV')]
    }
    const root = JSON.parse(patchDesignSettings(text, settings)!)
    expect(root.net_settings.classes[1].priority).toBe(3)
  })

  test('patch → extract round-trips classes and patterns', () => {
    const settings: BoardDesignSettings = {
      ...designSettings,
      classes: [...designSettings.classes, makeNetClass('HV')],
      patterns: [{ netClass: 'HV', pattern: 'GND' }]
    }
    const patched = patchDesignSettings(projectSource, settings)!
    // The file now carries the priorities the writer numbered.
    const [defaultClass, hv] = settings.classes
    expect(extractDesignSettings(patched)).toEqual({
      ...settings,
      classes: [
        { ...defaultClass, priority: 2147483647 },
        { ...hv, priority: 0 }
      ],
      severities: {},
      exclusions: []
    })
    expect(patchDesignSettings(patched, settings)).toBe(patched)
  })

  test('a field a class leaves unset stays unset through a save', () => {
    // Writing Default's value into it would pin the class to today's Default.
    const text = JSON.stringify({
      net_settings: {
        classes: [
          { name: 'Default', priority: 2147483647, clearance: 0.1, track_width: 0.2 },
          { name: 'HV', priority: 0, clearance: 1.5 }
        ]
      }
    })
    const read = extractDesignSettings(text)!
    const root = JSON.parse(patchDesignSettings(text, read)!)
    expect(root.net_settings.classes[1]).toEqual({ name: 'HV', priority: 0, clearance: 1.5 })
  })
})

describe('net class colors (KiCad pcb_color)', () => {
  const text = JSON.stringify({
    net_settings: {
      classes: [
        { name: 'Default', priority: 2147483647, pcb_color: 'rgba(0, 0, 0, 0.000)' },
        { name: 'Power', priority: 0, pcb_color: 'rgb(200, 40, 40)' },
        { name: 'USB', priority: 1, pcb_color: 'rgba(0, 0, 0, 0.000)' },
        { name: 'Fast', priority: 2, pcb_color: 'rgba(40, 90, 220, 0.500)' }
      ],
      netclass_patterns: [
        { netclass: 'USB', pattern: 'D*' },
        { netclass: 'Fast', pattern: 'D*' }
      ]
    }
  })

  test('a color is read, transparent is none, and a save writes it back in KiCad spelling', () => {
    const read = extractDesignSettings(text)!
    const byName = new Map(read.classes.map((c) => [c.name, c]))
    expect(byName.get('Power')?.pcbColor).toEqual({ r: 200, g: 40, b: 40, a: 1 })
    expect(byName.get('USB')?.pcbColor).toBeUndefined()
    expect(byName.get('Fast')?.pcbColor).toEqual({ r: 40, g: 90, b: 220, a: 0.5 })
    expect(patchDesignSettings(text, read)).toBe(
      patchDesignSettings(patchDesignSettings(text, read)!, read)
    )
    const classes = JSON.parse(patchDesignSettings(text, read)!).net_settings.classes
    expect(classes.map((c: { pcb_color?: string }) => c.pcb_color)).toEqual([
      'rgba(0, 0, 0, 0.000)',
      'rgb(200, 40, 40)',
      'rgba(0, 0, 0, 0.000)',
      'rgba(40, 90, 220, 0.500)'
    ])
  })

  test('a net in several classes takes the first color by priority, as KiCad does', () => {
    const { classes, patterns } = extractDesignSettings(text)!
    // USB outranks Fast but has no color, so Fast's shows.
    expect(netClassForNet('D+', classes, patterns).pcbColor).toEqual({
      r: 40,
      g: 90,
      b: 220,
      a: 0.5
    })
  })
})

describe('net class schematic styling (KiCad wire_width, bus_width, line_style, schematic_color)', () => {
  const text = JSON.stringify({
    net_settings: {
      classes: [
        { name: 'Default', priority: 2147483647, wire_width: 6, bus_width: 12, line_style: 0 },
        {
          name: 'Power',
          priority: 0,
          wire_width: 20,
          line_style: 1,
          schematic_color: 'rgb(200, 0, 0)'
        },
        { name: 'Analog', priority: 1 }
      ],
      netclass_patterns: [{ netclass: 'Power', pattern: '+*' }]
    }
  })

  test('read in mm and by style name, written back in mils and by number', () => {
    const read = extractDesignSettings(text)!
    const power = read.classes.find((c) => c.name === 'Power')!
    expect(power.wireWidth).toBeCloseTo(0.508, 9)
    expect(power.lineStyle).toBe('dash')
    expect(power.schematicColor).toEqual({ r: 200, g: 0, b: 0, a: 1 })
    expect(power.busWidth).toBeUndefined()
    const classes = JSON.parse(patchDesignSettings(text, read)!).net_settings.classes
    expect(classes[1]).toMatchObject({
      wire_width: 20,
      line_style: 1,
      schematic_color: 'rgb(200, 0, 0)'
    })
    expect(classes[2]).not.toHaveProperty('wire_width')
  })

  test('a width cleared on a class goes from the file, so the class inherits again', () => {
    const read = extractDesignSettings(text)!
    const cleared = read.classes.map((c) => {
      if (c.name !== 'Power') return c
      const next = { ...c }
      delete next.wireWidth
      return next
    })
    const classes = JSON.parse(patchDesignSettings(text, { ...read, classes: cleared })!)
      .net_settings.classes
    expect(classes[1]).not.toHaveProperty('wire_width')
  })
})

describe('KiCad project tuning profiles', () => {
  test("a profile's track geometry is read per signal layer, in mm, with its type", () => {
    const entry = (layer: string, width: number, gap: number): object => ({
      signal_layer: layer,
      top_reference_layer: 'UNDEFINED',
      bottom_reference_layer: 'UNDEFINED',
      width,
      diff_pair_gap: gap,
      delay: 0
    })
    const settings = extractDesignSettings(
      JSON.stringify({
        board: { design_settings: {} },
        net_settings: { classes: [{ name: 'Default', tuning_profile: 'USB' }] },
        tuning_profiles: {
          tuning_profiles_impedance_geometric: [
            {
              profile_name: 'USB',
              type: 1,
              layer_entries: [entry('F.Cu', 300000, 150000), entry('B.Cu', 0, 0)]
            }
          ]
        }
      })
    )
    expect(settings?.tuning?.geometries).toEqual({
      USB: {
        differential: true,
        layers: [
          { layer: 'F.Cu', width: 0.3, gap: 0.15 },
          { layer: 'B.Cu', width: 0, gap: 0 }
        ]
      }
    })
  })
})

describe('KiCad project tuning profiles, written', () => {
  // The shape KiCad 10.0.6 saves (common/project/tuning_profiles.cpp), with the
  // stale `generate_drc_rules` some of its QA projects still carry.
  const saved = {
    board: { design_settings: {} },
    net_settings: { classes: [{ name: 'Default', priority: 2147483647, tuning_profile: '' }] },
    tuning_profiles: {
      meta: { version: 0 },
      tuning_profiles_impedance_geometric: [
        {
          enable_time_domain_tuning: true,
          generate_drc_rules: false,
          layer_entries: [
            {
              bottom_reference_layer: 'In1.Cu',
              delay: 5990000,
              diff_pair_gap: 150000,
              signal_layer: 'F.Cu',
              top_reference_layer: 'UNDEFINED',
              width: 200000
            }
          ],
          profile_name: 'USB_90',
          target_impedance: 90.0,
          type: 1,
          via_overrides: [],
          via_prop_delay: 7000000
        }
      ]
    }
  }
  const text = `${JSON.stringify(saved, null, 2)}\n`

  test('a profile reads whole, and writes back byte for byte', () => {
    const profiles = extractDesignSettings(text)?.tuning?.definitions ?? []
    expect(profiles).toEqual([
      {
        name: 'USB_90',
        differential: true,
        targetImpedance: 90,
        timeDomain: true,
        layers: [
          {
            layer: 'F.Cu',
            topReference: '',
            bottomReference: 'In1.Cu',
            width: 0.2,
            gap: 0.15,
            delay: 5990000
          }
        ],
        viaDelay: 7000000,
        overrides: []
      }
    ])
    expect(patchTuningProfiles(text, profiles)).toBe(text)
  })

  test("an edit lands in KiCad's units, and a new profile is written with sorted keys", () => {
    const [usb] = extractDesignSettings(text)?.tuning?.definitions ?? []
    const rf: TuningProfile = {
      name: 'RF_50',
      differential: false,
      targetImpedance: 50,
      timeDomain: false,
      layers: [
        {
          layer: 'F.Cu',
          topReference: '',
          bottomReference: 'In1.Cu',
          width: 0.31,
          gap: 0,
          delay: 0
        }
      ],
      viaDelay: 0,
      overrides: []
    }
    const next = JSON.parse(
      patchTuningProfiles(text, [{ ...usb, layers: [{ ...usb.layers[0], width: 0.21 }] }, rf])!
    )
    const [a, b] = next.tuning_profiles.tuning_profiles_impedance_geometric
    expect(a.layer_entries[0].width).toBe(210000)
    expect(a.generate_drc_rules).toBe(false)
    expect(Object.keys(b)).toEqual([...Object.keys(b)].sort())
    expect(b.layer_entries[0]).toEqual({
      bottom_reference_layer: 'In1.Cu',
      delay: 0,
      diff_pair_gap: 0,
      signal_layer: 'F.Cu',
      top_reference_layer: 'UNDEFINED',
      width: 310000
    })
  })

  test('a project with no profiles is left alone; a class names one as KiCad writes it', () => {
    const bare = `${JSON.stringify({ board: {} }, null, 2)}\n`
    expect(patchTuningProfiles(bare, [])).toBe(bare)
    const settings = extractDesignSettings(text)!
    const classes = settings.classes.map((c) => ({ ...c, tuningProfile: 'USB_90' }))
    const written = JSON.parse(patchDesignSettings(text, { ...settings, classes })!)
    expect(written.net_settings.classes[0].tuning_profile).toBe('USB_90')
    expect(extractDesignSettings(JSON.stringify(written))?.classes[0].tuningProfile).toBe('USB_90')
    const cleared = settings.classes.map((c) => ({ ...c, tuningProfile: undefined }))
    expect(
      JSON.parse(patchDesignSettings(text, { ...settings, classes: cleared })!).net_settings
        .classes[0].tuning_profile
    ).toBe('')
  })
})

describe('net class resolution (routing reads this)', () => {
  test('matchesNetPattern: an anchored wildcard or an anchored regex, as KiCad reads one', () => {
    expect(matchesNetPattern('*', 'anything')).toBe(true)
    expect(matchesNetPattern('/*USB_*', '/usb/USB_DP')).toBe(true)
    expect(matchesNetPattern('GND', 'GND')).toBe(true)
    expect(matchesNetPattern('GND', 'gnd')).toBe(false)
    expect(matchesNetPattern('GND', 'GND2')).toBe(false)
    expect(matchesNetPattern('VBUS?', 'VBUS1')).toBe(true)
    expect(matchesNetPattern('*_P', 'DIFF_P')).toBe(true)
    expect(matchesNetPattern('*_P', 'DIFF_N')).toBe(false)
    expect(matchesNetPattern('', '')).toBe(true)
    expect(matchesNetPattern('**a*', 'bca')).toBe(true)
    // Read as a regex too: `?` makes the S optional, `|` alternates, `.*` is any run.
    expect(matchesNetPattern('VBUS?', 'VBUS')).toBe(true)
    expect(matchesNetPattern('/Plug|/Socket|', '/Socket-RX')).toBe(true)
    expect(matchesNetPattern('/Plug|/Socket|', 'GND')).toBe(false)
    expect(matchesNetPattern('.*/\\+.*|\\+.*', '+3V3')).toBe(true)
    expect(matchesNetPattern('.*/\\+.*|\\+.*', '/pwr/+5V')).toBe(true)
    expect(matchesNetPattern('.*/\\+.*|\\+.*', 'VCC')).toBe(false)
    // Text that is no valid expression is still a wildcard.
    expect(matchesNetPattern('(unclosed', '(unclosed')).toBe(true)
  })

  test('netClassForNet: every matching class, by priority, each field from the first that sets it', () => {
    const power: NetClass = { ...makeNetClass('Power'), trackWidth: 0.5, priority: 0 }
    const usb: NetClass = { ...makeNetClass('USB'), trackWidth: 0.2, priority: 1 }
    const classes = [...DEFAULT_NET_CLASSES, power, usb]
    const patterns = [
      { pattern: '*USB*', netClass: 'USB' },
      { pattern: 'V*', netClass: 'Power' }
    ]
    expect(netClassForNet('USB_DP', classes, patterns)).toBe(usb)
    expect(netClassForNet('VCC', classes, patterns)).toBe(power)
    // Both match: the lower priority number wins, whatever the pattern order.
    expect(netClassForNet('VUSB', classes, patterns)).toMatchObject({
      name: 'Power',
      trackWidth: 0.5
    })
    expect(netClassForNet('GND', classes, patterns).name).toBe(DEFAULT_CLASS_NAME)
    expect(netClassForNet('', classes, patterns).name).toBe(DEFAULT_CLASS_NAME)
    // A pattern naming a class that does not exist puts the net in KiCad's
    // implicit class of that name, which sets nothing: every value is Default's.
    const ghost = netClassForNet('X', classes, [{ pattern: '*', netClass: 'Ghost' }])
    expect(ghost.constituents).toEqual(['Ghost', DEFAULT_CLASS_NAME])
    expect(ghost.clearance).toBe(defaultNetClass(classes).clearance)
    // An explicit assignment joins the patterns' classes rather than replacing them.
    const assigned = [{ net: 'VCC', netClass: 'USB' }]
    expect(netClassForNet('VCC', classes, patterns, assigned)).toMatchObject({
      name: 'Power',
      trackWidth: 0.5
    })
    expect(netClassForNet('GND', classes, [], [{ net: 'GND', netClass: 'USB' }])).toBe(usb)
  })

  test('netClassForNet: an unset field comes from the next class that sets it, then Default', () => {
    const defaults: NetClass = { ...makeNetClass(DEFAULT_CLASS_NAME), clearance: 0.1 }
    const fast: NetClass = {
      ...makeNetClass('Fast'),
      trackWidth: 0.15,
      priority: 0,
      unset: ['clearance', 'viaDiameter']
    }
    const wide: NetClass = {
      ...makeNetClass('Wide'),
      viaDiameter: 0.9,
      priority: 1,
      unset: ['clearance']
    }
    const classes = [defaults, fast, wide]
    const patterns = [
      { pattern: 'CLK*', netClass: 'Fast' },
      { pattern: 'CLK_BIG', netClass: 'Wide' }
    ]
    const alone = netClassForNet('CLK1', classes, patterns)
    expect(alone.name).toBe('Fast')
    expect(alone.clearance).toBe(0.1)
    expect(alone.trackWidth).toBe(0.15)
    expect(alone.sources).toEqual({ clearance: 'Default', viaDiameter: 'Default' })
    const both = netClassForNet('CLK_BIG', classes, patterns)
    expect(both.name).toBe('Fast')
    expect(both.trackWidth).toBe(0.15)
    expect(both.viaDiameter).toBe(0.9)
    expect(both.clearance).toBe(0.1)
    expect(both.sources?.viaDiameter).toBe('Wide')
    expect(both.sources?.clearance).toBe('Default')
  })
})

describe('extractConnectionGrid', () => {
  test('reads the grid KiCad writes in mils', () => {
    const grid = extractConnectionGrid('{"schematic":{"connection_grid_size":100.0}}')
    expect(grid).toBe(mmToNm(spacingToMm(100, 'mil')))
  })

  test('is null when the project does not set it, or sets nonsense', () => {
    expect(extractConnectionGrid('{"schematic":{}}')).toBeNull()
    expect(extractConnectionGrid('{"schematic":{"connection_grid_size":0}}')).toBeNull()
    expect(extractConnectionGrid('not json')).toBeNull()
  })
})

describe('KiCad project rule severities', () => {
  const project = JSON.stringify({
    board: {
      design_settings: {
        rules: { min_clearance: 0.2 },
        rule_severities: { clearance: 'error', hole_to_hole: 'ignore', legacy_flag: true }
      }
    },
    erc: { erc_exclusions: [], rule_severities: { pin_not_connected: 'warning' } }
  })

  test('reads each scope where KiCad keeps it, dropping values that are no severity', () => {
    expect(extractRuleSeverities(project, 'drc')).toEqual({
      clearance: 'error',
      hole_to_hole: 'ignore'
    })
    expect(extractRuleSeverities(project, 'erc')).toEqual({ pin_not_connected: 'warning' })
    expect(extractDesignSettings(project)?.severities).toEqual({
      clearance: 'error',
      hole_to_hole: 'ignore'
    })
  })

  test('a project with none reads empty, and malformed JSON reads null', () => {
    expect(extractRuleSeverities(projectSource, 'drc')).toEqual({})
    expect(extractRuleSeverities(projectSource, 'erc')).toEqual({})
    expect(extractRuleSeverities('not json', 'erc')).toBeNull()
    expect(patchRuleSeverities('not json', 'erc', { x: 'error' })).toBeNull()
  })

  test('a patch changes only the named rules and keeps every sibling key', () => {
    const drc = JSON.parse(patchRuleSeverities(project, 'drc', { clearance: 'warning' })!)
    expect(drc.board.design_settings.rules).toEqual({ min_clearance: 0.2 })
    expect(drc.board.design_settings.rule_severities).toEqual({
      clearance: 'warning',
      hole_to_hole: 'ignore',
      legacy_flag: true
    })
    expect(drc.erc.rule_severities).toEqual({ pin_not_connected: 'warning' })

    const erc = JSON.parse(patchRuleSeverities(project, 'erc', { pin_to_pin: 'ignore' })!)
    expect(erc.erc).toEqual({
      erc_exclusions: [],
      rule_severities: { pin_not_connected: 'warning', pin_to_pin: 'ignore' }
    })
  })

  test('a patch creates the objects a project without them lacks', () => {
    const patched = patchRuleSeverities(projectSource, 'drc', { track_width: 'ignore' })!
    expect(extractRuleSeverities(patched, 'drc')).toEqual({ track_width: 'ignore' })
    expect(JSON.parse(patched).pcb).toBe('power_supply.kicad_pcb')
  })
})

describe('migrateProjectFile', () => {
  const hierarchy = {
    rootFile: 'demo.kicad_sch',
    rootUuid: 'aaaaaaaa-0000-0000-0000-000000000001',
    rootName: 'demo',
    sheets: [['bbbbbbbb-0000-0000-0000-000000000002', 'Power']] as Array<[string, string]>
  }

  test('fills what KiCad 10’s schematic editor writes, keeping what the project sets', () => {
    const before = JSON.stringify({
      erc: { rule_severities: { pin_to_pin: 'error' } },
      schematic: { legacy_lib_dir: '' },
      meta: { filename: 'demo.kicad_pro', version: 3 }
    })
    const project = JSON.parse(migrateProjectFile(before, null)!)
    expect(project.erc.rule_severities.pin_to_pin).toBe('error')
    expect(project.erc.rule_severities.wire_dangling).toBe('error')
    expect(project.erc.pin_map).toHaveLength(12)
    expect(project.schematic.legacy_lib_dir).toBe('')
    expect(project.schematic.connection_grid_size).toBe(50)
    expect(Object.keys(project.schematic)).toEqual([...Object.keys(project.schematic)].sort())
  })

  test('lists every sheet and gives the root its real uuid', () => {
    const before = JSON.stringify({
      schematic: {
        top_level_sheets: [
          { filename: 'demo.kicad_sch', name: 'demo', uuid: '00000000-0000-0000-0000-000000000000' }
        ]
      },
      sheets: [[hierarchy.rootUuid, 'Root']]
    })
    const project = JSON.parse(migrateProjectFile(before, hierarchy)!)
    expect(project.sheets).toEqual([
      [hierarchy.rootUuid, 'demo'],
      ['bbbbbbbb-0000-0000-0000-000000000002', 'Power']
    ])
    expect(project.schematic.top_level_sheets).toEqual([
      { filename: 'demo.kicad_sch', name: 'demo', uuid: hierarchy.rootUuid }
    ])
  })

  test('refuses malformed JSON rather than overwrite it', () => {
    expect(migrateProjectFile('{ not json', hierarchy)).toBeNull()
  })
})

describe('tuning settings from the page', () => {
  test("a profile held in the page's reactive state reads through, where a structured clone refuses it", () => {
    const profile = reactive({
      name: 'USB',
      differential: true,
      targetImpedance: 90,
      timeDomain: false,
      layers: [
        {
          layer: 'F.Cu',
          topReference: '',
          bottomReference: 'B.Cu',
          width: 0.36,
          gap: 0.2,
          delay: 1
        }
      ],
      viaDelay: 0,
      overrides: []
    })
    expect(() => tuningSettingsOf([profile], { USB: 'USB' })).not.toThrow()
    expect(tuningSettingsOf([profile], { USB: 'USB' }).geometries?.USB.layers[0].width).toBe(0.36)
  })
})

describe('the Board Setup choice (GoatCAD key)', () => {
  const PRO = JSON.stringify({ board: { design_settings: {} }, meta: { version: 3 } })

  test('none stored reads as Custom and adds nothing', () => {
    expect(extractDesignSettings(PRO)?.setupChoice).toBeUndefined()
  })

  test('stored, read back, and cleared to Custom without touching KiCad keys', () => {
    const picked = patchBoardSetupChoice(PRO, { profile: 'jlcpcb-4l-1.6', stackup: null })!
    expect(extractDesignSettings(picked)?.setupChoice).toEqual({
      profile: 'jlcpcb-4l-1.6',
      stackup: null
    })
    const cleared = patchBoardSetupChoice(picked, { profile: null })!
    expect(JSON.parse(cleared)).toEqual(JSON.parse(PRO))
  })
})
