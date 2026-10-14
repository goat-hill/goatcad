import type { DrcContext } from '../context'

export function customRules(ctx: DrcContext): void {
  const { emit, ruleSet } = ctx
  // A rule file with an error is set aside whole, as KiCad sets it aside: say so, once.
  if (ruleSet.customRules.errors.length > 0) {
    emit(
      {
        code: 'custom-rules',
        severity: 'error',
        message: `The custom rules (.kicad_dru) were not applied: ${ruleSet.customRules.errors.join('; ')}`,
        items: ['.kicad_dru'],
        targets: [],
        subject: 'Custom rules'
      },
      []
    )
  }
}
