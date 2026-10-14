/**
 * What `symbol.check` and `footprint.check` answer: one row per rule, `ok`
 * and the counts (docs/MCP-STYLE.md, "Answer shapes"). A definition has no
 * revision, so there is no `since` either.
 */
import type { McpCheckAnswer } from '../../../../preload/mcpTypes'
import { groupChecks, withAskedCodes, type CheckResult } from '../schematic/checks'

export const checkAnswer = (
  results: CheckResult[],
  rules: Record<string, string>,
  guidance: string,
  codes?: readonly string[]
): McpCheckAnswer => ({
  ok: !results.some((result) => result.severity === 'error'),
  checks: withAskedCodes(groupChecks(results, rules), codes, rules),
  counts: {
    error: results.filter((result) => result.severity === 'error').length,
    warning: results.filter((result) => result.severity === 'warning').length
  },
  guidance
})
