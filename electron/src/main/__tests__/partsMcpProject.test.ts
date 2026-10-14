import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS_FILE,
  CONTEXT_GUIDANCE,
  contextGuidance,
  INTENT_FILE,
  linksIntent,
  missingConventionsSections,
  readFootprintStyle,
  readProjectContext
} from '../partsMcpProject'
import { CONVENTIONS_SECTIONS, INIT_PROJECT_PROMPT } from '../partsMcpPrompts'

const withProject = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'goatcad-intent-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('reading the intent file', () => {
  it('returns it verbatim rather than parsed', () => {
    withProject((dir) => {
      // Unparsed on purpose: the reader is a language model, and parsing would
      // cost a YAML dependency to buy nothing.
      const raw = '---\nassembly:\n  method: hotplate\n---\n\n## Goal\n\nAir quality logger.\n'
      writeFileSync(join(dir, INTENT_FILE), raw)
      const context = readProjectContext(() => dir)
      expect(context.exists).toBe(true)
      expect(context.content).toBe(raw)
      expect(context.problem).toBeNull()
      expect(context.intentPath).toBe(join(dir, INTENT_FILE))
    })
  })

  it('distinguishes "not written yet" from "no project open"', () => {
    withProject((dir) => {
      expect(readProjectContext(() => dir).problem).toBe('not-created')
    })
    expect(readProjectContext(() => null).problem).toBe('no-project')
  })

  it('refuses a file too large to be an intent document', () => {
    withProject((dir) => {
      writeFileSync(join(dir, INTENT_FILE), 'x'.repeat(300 * 1024))
      const context = readProjectContext(() => dir)
      expect(context.problem).toBe('too-large')
      // And it does not hand back the content anyway.
      expect(context.content).toBeNull()
    })
  })

  it('reports when the file exists but cannot be read', () => {
    withProject((dir) => {
      // A directory where a file should be: stat succeeds, read does not.
      mkdirSync(join(dir, INTENT_FILE))
      expect(readProjectContext(() => dir).problem).toBe('unreadable')
    })
  })
})

describe('what an agent is told', () => {
  it('never lets a missing file read as "no constraints"', () => {
    // The failure this whole feature exists to fix: an empty answer is one an
    // agent proceeds from, inventing the assembly method and build quantity.
    const guidance = CONTEXT_GUIDANCE['not-created']
    expect(guidance).toContain('not the same as having no constraints')
    expect(guidance).toContain('as a guess')
    expect(guidance).toContain('/mcp__goatcad__init')
  })

  it('tells an agent that assumed fields are guesses, not decisions', () => {
    expect(CONTEXT_GUIDANCE.ok).toContain('assumed')
    expect(CONTEXT_GUIDANCE.ok).toContain('inferred rather than stated')
  })

  it('has guidance for every state, so none can answer silently', () => {
    for (const key of ['ok', 'no-project', 'not-created', 'too-large', 'unreadable'] as const) {
      expect(CONTEXT_GUIDANCE[key].length).toBeGreaterThan(40)
    }
  })
})

describe('what init left unwritten', () => {
  const sections = CONVENTIONS_SECTIONS.map((name) => `## ${name}\n\n- a rule\n`).join('\n')

  it('names the conventions headings the intent file lacks', () => {
    // Run 11's shape: a hand-written intent with one "Conventions" heading.
    expect(missingConventionsSections('## Purpose\n\n## Conventions\n- Values: 10k\n')).toEqual([
      ...CONVENTIONS_SECTIONS
    ])
    expect(missingConventionsSections(sections)).toEqual([])
    // Any heading level, case aside, trailing hashes allowed; prose does not count.
    expect(
      missingConventionsSections(
        '### schematic CONVENTIONS ##\n# Footprint conventions\nWorking on the schematic\n## board conventions\n## Choosing parts'
      )
    ).toEqual(['Working on the schematic'])
  })

  it('counts AGENTS.md as set up only when it links board-intent.md', () => {
    expect(linksIntent('Context is in [board-intent.md](board-intent.md).')).toBe(true)
    expect(linksIntent('[the intent](./board-intent.md#layout)')).toBe(true)
    expect(linksIntent('Read board-intent.md first.')).toBe(false)
    expect(linksIntent('[x](other/board-intent.md)')).toBe(false)
  })

  it('reports both facts beside the content', () => {
    withProject((dir) => {
      writeFileSync(join(dir, INTENT_FILE), '## Goal\n\n## Schematic conventions\n')
      const bare = readProjectContext(() => dir)
      expect(bare.agentsPath).toBe(join(dir, AGENTS_FILE))
      expect(bare.agentsExists).toBe(false)
      expect(bare.agentsHasSection).toBe(false)
      expect(bare.missingSections).toEqual(CONVENTIONS_SECTIONS.slice(1))
      expect(contextGuidance(bare)).toContain('/mcp__goatcad__init')

      writeFileSync(join(dir, AGENTS_FILE), '# Notes\n\nNothing about GoatCAD.\n')
      const unlinked = readProjectContext(() => dir)
      expect(unlinked.agentsExists).toBe(true)
      expect(unlinked.agentsHasSection).toBe(false)

      writeFileSync(join(dir, INTENT_FILE), sections)
      writeFileSync(join(dir, AGENTS_FILE), 'See [board-intent.md](board-intent.md).\n')
      const complete = readProjectContext(() => dir)
      expect(complete.agentsHasSection).toBe(true)
      expect(complete.missingSections).toEqual([])
      expect(contextGuidance(complete)).toBe(CONTEXT_GUIDANCE.ok)
    })
  })

  it('lists every section when there is no intent file, and none it could not read', () => {
    withProject((dir) => {
      expect(readProjectContext(() => dir).missingSections).toEqual([...CONVENTIONS_SECTIONS])
      mkdirSync(join(dir, INTENT_FILE))
      expect(readProjectContext(() => dir).missingSections).toBeNull()
    })
    expect(readProjectContext(() => null).agentsPath).toBeNull()
  })

  it('matches what the init prompt tells the agent to write', () => {
    const prompt = INIT_PROJECT_PROMPT.render({})
    for (const name of CONVENTIONS_SECTIONS) expect(prompt).toContain(`## ${name}\n`)
    expect(linksIntent(prompt)).toBe(true)
  })
})

describe('readFootprintStyle', () => {
  it('reads the two choices from the frontmatter', () => {
    const content = `---
goal: a phone line interface
assembly:
  method: pcba
footprints:
  density: least        # a comment
  pin1_marker: "dot"
---

## Goal
`
    expect(readFootprintStyle(content)).toEqual({
      density: 'least',
      pin1Marker: 'dot',
      source: 'board-intent'
    })
  })

  it('defaults density from the assembly method when the file does not say', () => {
    const content = `---
assembly:
  method: hand-solder
  min_passive: "0805"
---
`
    expect(readFootprintStyle(content)).toEqual({
      density: 'most',
      pin1Marker: 'chevron',
      source: 'default'
    })
  })

  it('ignores a value outside its list, and a key outside the block', () => {
    const content = `---
density: least
footprints:
  density: huge
  pin1_marker: line
---
`
    expect(readFootprintStyle(content)).toEqual({
      density: 'nominal',
      pin1Marker: 'line',
      source: 'board-intent'
    })
    expect(readFootprintStyle(null)).toEqual({
      density: 'nominal',
      pin1Marker: 'chevron',
      source: 'default'
    })
  })
})
