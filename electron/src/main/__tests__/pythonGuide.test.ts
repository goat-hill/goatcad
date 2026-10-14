import { describe, expect, it } from 'vitest'
import { registry } from '../ops'
import { pythonSpelling, renderPythonGuide, renderPythonInit } from '../pythonGuide'

describe('the Python guide', () => {
  const ops = registry.list()
  const guide = renderPythonGuide(ops, '/config/python')

  it('lists every operation, so none goes unused for want of being seen', () => {
    for (const op of ops) expect(guide).toContain(`gc.${op.name}(`)
  })

  it('spells every operation the way the client calls it, never as an MCP tool', () => {
    for (const op of ops) expect(guide).not.toMatch(new RegExp(`\\b${op.mcpName}\\b`))
  })

  it('gives each operation its arguments, required first, optional marked', () => {
    const line = guide.split('\n').find((text) => text.startsWith('gc.schematic.place_symbol('))
    expect(line).toMatch(/^gc\.schematic\.place_symbol\(symbol, at, .*pin\?.*\): /)
    // Every call takes workspace, which connect() sets, so no line spends tokens on it.
    expect(line).not.toContain('workspace')
  })

  it('carries the working method, respelled, and points at INIT.md', () => {
    expect(guide).toContain('## How to work')
    expect(guide).toContain('gc.viewport.open')
    expect(guide).toContain('INIT.md')
  })

  it('writes the init prompt as it is, only respelled', () => {
    const init = renderPythonInit(ops)
    expect(init).toContain('gc.project.context')
    // The board-intent.md template keeps its headings: they are the file the agent writes.
    expect(init).toMatch(/^## Schematic conventions$/m)
  })

  it('respells wildcards over a domain or a verb', () => {
    expect(pythonSpelling('parts_* and each *_check', ops)).toBe('gc.parts.* and each gc.*.check')
    // A word that only looks like a domain wildcard is left alone.
    expect(pythonSpelling('PWR_FLAG and not_a_domain_*', ops)).toBe('PWR_FLAG and not_a_domain_*')
  })
})
