import { describe, expect, it } from 'vitest'
import { ANSWER_LIST_MAX, capAnswerLists } from '../answerLists'
import { registry } from '../index'

const ids = (n: number, prefix = 'id'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`)

describe('large answers', () => {
  it('leaves an answer with no long list as it is', () => {
    const answer = { changed: { created: ids(3), updated: [], deleted: [] }, revision: 4 }
    expect(capAnswerLists(answer)).toBe(answer)
  })

  it('caps changed, with every length in its counts and truncated beside them', () => {
    const answer = {
      changed: { created: ids(2), updated: [], deleted: ids(443) },
      revision: 9,
      guidance: 'One undo step.'
    }
    const capped = capAnswerLists(answer) as typeof answer & {
      changed: { counts: unknown; truncated: boolean }
    }
    expect(capped.changed.deleted).toHaveLength(ANSWER_LIST_MAX)
    expect(capped.changed.created).toEqual(['id0', 'id1'])
    expect(capped.changed.counts).toEqual({ created: 2, updated: 0, deleted: 443 })
    expect(capped.changed.truncated).toBe(true)
    expect(capped.guidance).toMatch(/^One undo step\. A list marked truncated/)
    expect(capped.guidance).toContain('app_scripting')
    // The answer the door gave, which /v1 returns, keeps every id.
    expect(answer.changed.deleted).toHaveLength(443)
  })

  it("caps each batch entry's changed and an op's declared rows, counted where they sit", () => {
    const answer = {
      changed: { created: ids(150), updated: [], deleted: [] },
      results: [{ changed: { created: ids(150), updated: [], deleted: [] } }],
      escapes: ids(120, 'pad'),
      counts: { vias: 120 },
      nets: { added: ids(130, 'net'), removed: [] }
    }
    const capped = capAnswerLists(answer, ['escapes', 'nets.added', 'missing']) as Record<
      string,
      never
    >
    expect((capped.results as Array<{ changed: { counts: unknown } }>)[0].changed.counts).toEqual({
      created: 150,
      updated: 0,
      deleted: 0
    })
    expect(capped.escapes).toHaveLength(ANSWER_LIST_MAX)
    expect(capped.counts).toEqual({ vias: 120, escapes: 120 })
    expect(capped.truncated).toBe(true)
    expect(capped.nets).toMatchObject({ counts: { added: 130 }, truncated: true })
  })

  it('declares only lists that exist on ops that answer them', () => {
    const declared = registry.list().filter((op) => op.lists.length)
    expect(declared.map((op) => op.name).sort()).toEqual([
      'board.cleanup',
      'board.fanout',
      'board.sync',
      'board.update_footprints',
      'board.update_tuning_patterns',
      'route.finish',
      'schematic.annotate',
      'schematic.set_paper',
      'schematic.update_symbols'
    ])
  })
})
