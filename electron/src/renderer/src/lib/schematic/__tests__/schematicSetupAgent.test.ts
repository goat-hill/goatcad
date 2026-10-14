import { describe, expect, test } from 'vitest'
import { createSchematicSetupAgent } from '../schematicSetupAgent'
import type { CheckResult } from '../checks'

const PROJECT = JSON.stringify(
  { erc: { rule_severities: { pin_not_connected: 'warning' } } },
  null,
  2
)

const finding = (code: string, severity: 'error' | 'warning'): CheckResult => ({
  code,
  severity,
  message: code,
  items: ['U1.1']
})

const setup = (): {
  agent: ReturnType<typeof createSchematicSetupAgent>
  texts: Map<string, string>
} => {
  const texts = new Map([['/p/p.kicad_pro', PROJECT]])
  let results: CheckResult[] = [finding('unconnected-pin', 'warning')]
  const agent = createSchematicSetupAgent({
    projectFile: () => '/p/p.kicad_pro',
    readText: async (path) => texts.get(path) ?? null,
    writeProject: async (path, content) => {
      texts.set(path, content)
      return true
    },
    rootSheet: async () => ({
      checks: () => results,
      reloadHierarchy: async () => {
        // The session re-reads the severity the write set.
        results = [finding('unconnected-pin', 'error')]
      }
    })
  })
  return { agent, texts }
}

describe('schematic setup', () => {
  test('reads the ERC severities with the ones the project changed', async () => {
    const { agent } = setup()
    const answer = (await agent.dispatch({ kind: 'get-schematic-setup' })) as {
      severities: { rules: Record<string, string>; changed: string[] }
    }
    expect(answer.severities.rules.pin_not_connected).toBe('warning')
    expect(answer.severities.changed).toContain('pin_not_connected')
  })

  test('writes a severity, answers what it replaced and how the findings re-ranked', async () => {
    const { agent, texts } = setup()
    const answer = (await agent.dispatch({
      kind: 'update-schematic-setup',
      changes: { severities: { pin_not_connected: 'error' } },
      checks: true
    })) as Record<string, unknown>
    expect(answer.before).toEqual({ severities: { pin_not_connected: 'warning' } })
    expect(JSON.parse(texts.get('/p/p.kicad_pro')!).erc.rule_severities.pin_not_connected).toBe(
      'error'
    )
    expect(answer.counts).toEqual({
      before: { errors: 0, warnings: 1 },
      after: { errors: 1, warnings: 0 }
    })
  })

  test('exclusions are read-only and an unknown rule is named', async () => {
    const { agent } = setup()
    expect(
      await agent.dispatch({ kind: 'update-schematic-setup', changes: { exclusions: [] } })
    ).toMatchObject({ error: 'not-applicable' })
    expect(
      await agent.dispatch({
        kind: 'update-schematic-setup',
        changes: { severities: { pin_not_conected: 'error' } }
      })
    ).toMatchObject({ error: 'invalid-record' })
  })
})
