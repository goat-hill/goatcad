import { describe, expect, test } from 'vitest'
import { planInterfacePreset, stackupSolver, type PresetContext } from '../interfacePresets'
import { INTERFACE_PRESETS } from '../interfacePresetData'
import { copperNamesFor } from '../boardSetupSchema'
import { solverStackupOf } from '../impedance'
import { parseKicadBoard } from '../../kicad/board'
import { DEFAULT_NET_CLASSES } from '../../kicad/project'
import { parseRules } from '../rules/dru'
import { patchRules } from '../rules/druRules'

const BOARD = parseKicadBoard(`(kicad_pcb (version 20240108) (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (setup) (net 0 ""))`)
const solve = stackupSolver(solverStackupOf(BOARD))

const ctx = (over: Partial<PresetContext> = {}): PresetContext => ({
  copperLayers: copperNamesFor(2),
  netNames: [
    '/USB_D+',
    '/USB_D-',
    '/ANT',
    'GND',
    '/CAM_D0_P',
    '/CAM_D0_N',
    '/CAM_CLK_P',
    '/CAM_CLK_N'
  ],
  classes: DEFAULT_NET_CLASSES,
  patterns: [],
  tuningProfiles: [],
  minClearance: 0.1,
  minTrackWidth: 0.1,
  ...over
})

const parses = (text: string): void => {
  const parsed = parseRules(
    text,
    { layersMatching: () => new Set<string>(), netNames: new Set<string>() },
    [{ name: 'F.Cu' }]
  )
  expect(parsed.errors).toEqual([])
}

describe('interface presets', () => {
  test('every value names a source the preset carries', () => {
    for (const preset of INTERFACE_PRESETS)
      for (const mode of preset.modes)
        for (const sourced of [mode.impedance, mode.tolerance, ...mode.rules.map((r) => r.max)])
          if (sourced)
            expect(preset.sources[sourced.source], `${preset.id} ${sourced.source}`).toBeDefined()
  })

  test("USB 2.0 High Speed: a 90 Ω profile per layer, the class's pair sizes, its rules", () => {
    const result = planInterfacePreset(
      ctx(),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
      solve
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { plan } = result
    expect(plan.report.pairs).toEqual([['/USB_D+', '/USB_D-']])
    expect(plan.report.layers.map((l) => l.layer)).toEqual(['F.Cu', 'B.Cu'])
    for (const layer of plan.report.layers) expect(layer.ohms).toBeCloseTo(90, 0)
    const profile = plan.tuningProfiles[0]
    expect(profile).toMatchObject({ name: 'USB', differential: true, targetImpedance: 90 })
    expect(profile.timeDomain).toBe(false)
    const usb = plan.classes.find((c) => c.name === 'USB')!
    expect(usb).toMatchObject({ tuningProfile: 'USB', diffPairGap: 0.2 })
    expect(usb.diffPairWidth).toBe(profile.layers[0].width)
    expect(plan.patterns).toEqual([{ pattern: '/USB_D*', netClass: 'USB' }])
    expect(plan.report.rules.join('\n')).toContain(
      '(constraint skew (max 50mil) (within_diff_pairs))'
    )
    parses(patchRules(undefined, [], plan.rules))
  })

  test("USB 2.0 Full Speed uncontrolled holds no impedance: no profile, the Default class's sizes, its rules", () => {
    // A class an earlier High Speed apply sized: Full Speed puts it back.
    const high = planInterfacePreset(
      ctx(),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
      solve
    )
    if (!high.ok) throw new Error(high.detail)
    const result = planInterfacePreset(
      ctx({
        classes: high.plan.classes,
        patterns: high.plan.patterns,
        tuningProfiles: high.plan.tuningProfiles
      }),
      { preset: 'usb2', mode: 'full-uncontrolled', netClass: 'USB' },
      solve
    )
    if (!result.ok) throw new Error(result.detail)
    const { plan } = result
    expect(plan.report).toMatchObject({ controlled: false, layers: [], alternatives: [] })
    expect(plan.report.pairs).toEqual([['/USB_D+', '/USB_D-']])
    const base = DEFAULT_NET_CLASSES[0]
    const usb = plan.classes.find((c) => c.name === 'USB')!
    expect(usb.tuningProfile).toBeUndefined()
    expect(usb).toMatchObject({ diffPairWidth: base.diffPairWidth, diffPairGap: base.diffPairGap })
    expect(plan.report.rules.join('\n')).toContain('(within_diff_pairs)')
  })

  test('Ethernet: MDI pairs at 100 Ω, an MII group at 50 Ω matched across its class', () => {
    const nets = ['/MDI0+', '/MDI0-', '/TXD0', '/TXD1', '/TX_CLK']
    const mdi = planInterfacePreset(
      ctx({ netNames: nets }),
      { preset: 'ethernet-mdi', mode: '100m', netClass: 'ETH', patterns: ['/MDI*'] },
      solve
    )
    if (!mdi.ok) throw new Error(mdi.detail)
    expect(mdi.plan.report.pairs).toEqual([['/MDI0+', '/MDI0-']])
    for (const layer of mdi.plan.report.layers) expect(layer.ohms).toBeCloseTo(100, 0)
    expect(mdi.plan.report.rules.join('\n')).toContain(
      '(constraint skew (max 50mil) (within_diff_pairs))'
    )
    const tx = planInterfacePreset(
      ctx({ netNames: nets }),
      { preset: 'rgmii', netClass: 'RGMII_TX', patterns: ['/TX*'] },
      solve
    )
    if (!tx.ok) throw new Error(tx.detail)
    expect(tx.plan.report.nets).toEqual(['/TXD0', '/TXD1', '/TX_CLK'])
    for (const layer of tx.plan.report.layers) expect(layer.ohms).toBeCloseTo(50, 0)
    const text = tx.plan.report.rules.join('\n')
    expect(text).toContain('(constraint skew (max 20mil))')
    expect(text).toContain('(constraint length (max 6000mil))')
    parses(patchRules(undefined, [], [...mdi.plan.rules, ...tx.plan.rules]))
  })

  test('the same request plans the same files, and applying again replaces, never doubles', () => {
    const request = { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] }
    const first = planInterfacePreset(ctx(), request, solve)
    if (!first.ok) throw new Error(first.detail)
    expect(JSON.stringify(planInterfacePreset(ctx(), request, solve))).toBe(JSON.stringify(first))
    const again = planInterfacePreset(
      ctx({
        classes: first.plan.classes,
        patterns: first.plan.patterns,
        tuningProfiles: first.plan.tuningProfiles
      }),
      request,
      solve
    )
    if (!again.ok) throw new Error(again.detail)
    expect(again.plan.tuningProfiles).toHaveLength(1)
    expect(again.plan.patterns).toHaveLength(1)
    expect(again.plan.classes.filter((c) => c.name === 'USB')).toHaveLength(1)
  })

  test('nets KiCad would not pair are refused by name, never guessed', () => {
    expect(
      planInterfacePreset(
        ctx({ netNames: ['/USB_DP', '/USB_DM'] }),
        { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
        solve
      )
    ).toMatchObject({ ok: false, code: 'unpaired', candidates: ['/USB_DP', '/USB_DM'] })
    expect(
      planInterfacePreset(ctx(), { preset: 'usb2', netClass: 'USB', patterns: ['/NOPE*'] }, solve)
    ).toMatchObject({ ok: false, code: 'no-nets' })
  })

  test("the gap is the Default class's clearance, never under the fab's, and shown with its reason", () => {
    const working = DEFAULT_NET_CLASSES[0].clearance
    const derived = planInterfacePreset(
      ctx(),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
      solve
    )
    if (!derived.ok) throw new Error(derived.detail)
    expect(derived.plan.report).toMatchObject({ gap: working, gapSource: 'classClearance' })
    // The outer copper unless asked; the trade-off listed beside it.
    expect(derived.plan.report.layers.map((l) => l.layer)).toEqual(['F.Cu', 'B.Cu'])
    expect(derived.plan.report.alternatives.map((a) => a.gap)).toContain(working)
    const fab = planInterfacePreset(
      ctx({ minClearance: working + 0.1 }),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
      solve
    )
    if (!fab.ok) throw new Error(fab.detail)
    expect(fab.plan.report).toMatchObject({ gap: working + 0.1, gapSource: 'fabClearance' })
  })

  test('a width the fab cannot build widens the derived gap; a given one is refused', () => {
    const at = planInterfacePreset(
      ctx(),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
      solve
    )
    if (!at.ok) throw new Error(at.detail)
    const width = Math.min(...at.plan.report.layers.map((l) => l.width))
    const wider = planInterfacePreset(
      ctx({ minTrackWidth: width + 0.02 }),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
      solve
    )
    if (!wider.ok) throw new Error(wider.detail)
    expect(wider.plan.report.gapSource).toBe('widened')
    expect(wider.plan.report.gap).toBeGreaterThan(at.plan.report.gap)
    for (const l of wider.plan.report.layers) expect(l.width).toBeGreaterThanOrEqual(width + 0.02)
    expect(
      planInterfacePreset(
        ctx({ minTrackWidth: width + 0.02 }),
        { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'], gap: at.plan.report.gap },
        solve
      )
    ).toMatchObject({ ok: false, code: 'below-fab' })
  })

  test('a typed width solves the gap for it, and the width comes back as typed', () => {
    const at = planInterfacePreset(
      ctx(),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'], gap: 0.15 },
      solve
    )
    if (!at.ok) throw new Error(at.detail)
    const width = at.plan.report.layers[0].width
    const held = planInterfacePreset(
      ctx(),
      { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'], width },
      solve
    )
    if (!held.ok) throw new Error(held.detail)
    expect(held.plan.report).toMatchObject({ gap: 0.15, gapSource: 'fromWidth' })
    expect(held.plan.report.layers[0].width).toBeCloseTo(width, 2)
    expect(
      planInterfacePreset(
        ctx({ minTrackWidth: width + 0.1 }),
        { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'], width },
        solve
      )
    ).toMatchObject({ ok: false, code: 'below-fab' })
  })

  test('a class with no nets yet is set up all the same; its pairs wait for its nets', () => {
    const result = planInterfacePreset(
      ctx({ netNames: ['GND'] }),
      { preset: 'usb2', netClass: 'USB' },
      solve
    )
    if (!result.ok) throw new Error(result.detail)
    expect(result.plan.report.nets).toEqual([])
    expect(result.plan.tuningProfiles[0]).toMatchObject({ name: 'USB', differential: true })
    expect(result.plan.rules.length).toBeGreaterThan(0)
  })

  test('a 50 Ω coplanar feed: the outer layers only, its gap the class clearance', () => {
    const result = planInterfacePreset(
      ctx(),
      { preset: 'rf-50', netClass: 'RF', patterns: ['/ANT'], gap: 0.15 },
      solve
    )
    if (!result.ok) throw new Error(result.detail)
    const rf = result.plan.classes.find((c) => c.name === 'RF')!
    expect(rf.clearance).toBe(0.15)
    expect(rf.trackWidth).toBeGreaterThan(0)
    expect(result.plan.rules).toEqual([])
  })

  test('CSI-2 holds lanes to the clock in ps, so its profile tunes in the time domain', () => {
    const result = planInterfacePreset(
      ctx(),
      { preset: 'csi2', mode: '1g5', netClass: 'CSI', patterns: ['/CAM_*'] },
      solve
    )
    if (!result.ok) throw new Error(result.detail)
    expect(result.plan.report.pairs).toHaveLength(2)
    expect(result.plan.tuningProfiles[0].timeDomain).toBe(true)
    expect(result.plan.report.rules.join('\n')).toContain('(constraint skew (max 50ps))')
    parses(patchRules(undefined, [], result.plan.rules))
  })
})
