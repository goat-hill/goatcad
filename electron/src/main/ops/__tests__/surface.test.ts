import { describe, expect, it } from 'vitest'
import { registry } from '../index'
import { argumentsOf, toolInfo } from '../surface'
import { s } from '../schema'

describe("the server's surface for Settings", () => {
  it('reads arguments off the schema: type, need, bounds, values and nested fields', () => {
    const schema = s.object({
      board: s.string().describe('Which board.').optional(),
      maxPixels: s.integer().min(256).max(16384),
      side: s.enum(['front', 'back'] as const).optional(),
      columns: s
        .array(s.object({ label: s.string(), field: s.string().optional() }))
        .min(1)
        .optional()
    }).json
    expect(argumentsOf(schema)).toEqual([
      { name: 'board', type: 'string', required: false, description: 'Which board.' },
      { name: 'maxPixels', type: 'integer', required: true, min: 256, max: 16384 },
      { name: 'side', type: 'enum', required: false, values: ['front', 'back'] },
      {
        name: 'columns',
        type: 'object[]',
        required: false,
        min: 1,
        fields: [
          { name: 'label', type: 'string', required: true },
          { name: 'field', type: 'string', required: false }
        ]
      }
    ])
  })

  it('describes every registered tool by its domain, without restating its summary', () => {
    const tools = registry.list().map(toolInfo)
    const render = tools.find((tool) => tool.name === 'render.gerbers')!
    expect(render).toMatchObject({ domain: 'render', mcpName: 'render_gerbers', mutates: false })
    expect(render.guidance).not.toContain(render.summary)
    expect(render.arguments.map((a) => a.name)).toContain('layers')
  })
})
