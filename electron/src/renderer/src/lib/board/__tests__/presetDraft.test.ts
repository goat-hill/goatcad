import { describe, expect, test } from 'vitest'
import { previewPreset } from '../presetDraft'
import { planInterfacePreset, stackupSolver } from '../interfacePresets'
import {
  customRuleRows,
  editCustomRule,
  limitText,
  NEW_RULE_TEXT,
  removeCustomRule
} from '../customRuleRows'
import { copperNamesFor, type BoardSetupModel } from '../boardSetupSchema'
import { solverStackupOf } from '../impedance'
import { parseKicadBoard } from '../../kicad/board'
import { DEFAULT_NET_CLASSES, DEFAULT_DESIGN_RULES } from '../../kicad/project'

const BOARD = parseKicadBoard(`(kicad_pcb (version 20240108) (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (setup) (net 0 ""))`)

const model = {
  classes: DEFAULT_NET_CLASSES,
  patterns: [],
  tuningProfiles: []
} as unknown as BoardSetupModel
const USER = `(version 1)
(rule "HV"
\t(condition "A.NetClass == 'HV'")
\t(constraint clearance (min 1.5mm)))
`

const plan = (): NonNullable<ReturnType<typeof planInterfacePreset> & { ok: true }>['plan'] => {
  const result = planInterfacePreset(
    {
      copperLayers: copperNamesFor(2),
      netNames: ['/USB_D+', '/USB_D-'],
      classes: DEFAULT_NET_CLASSES,
      patterns: [],
      tuningProfiles: [],
      minClearance: DEFAULT_DESIGN_RULES.minClearance,
      minTrackWidth: 0
    },
    { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'] },
    stackupSolver(solverStackupOf(BOARD))
  )
  if (!result.ok) throw new Error(result.detail)
  return result.plan
}

describe('an interface preset as a draft', () => {
  test('every piece it writes shows as added, where it will live', () => {
    const preview = previewPreset(model, USER, plan())
    expect(preview.pending.classes.get('USB')).toBe('added')
    expect([...preview.pending.patterns]).toEqual([0])
    expect(preview.pending.profiles.get('USB')).toBe('added')
    expect([...preview.pending.rules.values()]).toEqual(['added', 'added', 'added'])
    // The user's rule is kept and unmarked; the preset's read back as rules.
    const rows = customRuleRows(preview.rulesText).rows
    expect(rows[0]).toMatchObject({ rule: 'HV', limit: '≥ 1.5 mm' })
    expect(rows.find((r) => r.constraint === 'skew')).toMatchObject({
      rule: 'USB skew within pairs',
      limit: '≤ 1.27 mm, within each pair'
    })
    // Plain KiCad: nothing of ours beside the rules.
    expect(preview.rulesText).not.toContain('#')
  })

  test('applied once, the same draft changes nothing', () => {
    const p = plan()
    const first = previewPreset(model, USER, p)
    const again = previewPreset(first.model, first.rulesText, p)
    expect(again.pending.classes.size).toBe(0)
    expect(again.pending.patterns.size).toBe(0)
    expect(again.pending.profiles.size).toBe(0)
    expect(again.pending.rules.size).toBe(0)
  })

  test('a limit reads as a person writes one', () => {
    expect(limitText('via_count', { max: 4 })).toBe('≤ 4')
    expect(limitText('track_width', { min: 0.1, max: 0.2 })).toBe('0.1–0.2 mm')
    expect(limitText('skew', { max: 30, timeDomain: true })).toBe('≤ 30 ps')
  })
})

describe('custom rules, edited by hand', () => {
  const LAYERS = [{ name: 'F.Cu' }, { name: 'B.Cu' }]
  test('a rule edited as text lands in place, and a removed one goes with its line', () => {
    const edited = editCustomRule(
      USER,
      'HV',
      `(rule "HV"\n\t(condition "A.NetClass == 'HV'")\n\t(constraint clearance (min 2mm)))`,
      LAYERS
    )
    expect(edited).toMatchObject({ ok: true })
    if (!edited.ok) return
    expect(customRuleRows(edited.text).rows[0].limit).toBe('≥ 2 mm')
    const added = editCustomRule(edited.text, null, NEW_RULE_TEXT, LAYERS)
    if (!added.ok) throw new Error(added.errors.join())
    expect(customRuleRows(added.text).rows.map((r) => r.rule)).toEqual(['HV', 'New rule'])
    expect(customRuleRows(removeCustomRule(added.text, 'HV')).rows.map((r) => r.rule)).toEqual([
      'New rule'
    ])
  })

  test('text KiCad would not read is refused with why, and so is more than one rule', () => {
    expect(
      editCustomRule(USER, 'HV', '(rule "HV" (constraint nonsense (min 1mm)))', LAYERS)
    ).toMatchObject({ ok: false })
    expect(editCustomRule(USER, null, `${NEW_RULE_TEXT}\n${NEW_RULE_TEXT}`, LAYERS)).toEqual({
      ok: false,
      errors: ['one-rule']
    })
  })
})
