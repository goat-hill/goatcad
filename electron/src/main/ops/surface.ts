/**
 * The server's surface as Settings shows it (`mcp:surface`): every tool from
 * the registry and every prompt, with arguments read off the published JSON
 * Schema rather than restated, so the page cannot drift from what runs.
 */
import type { McpArgumentInfo, McpToolInfo } from '../../preload/mcpTypes'
import type { RegisteredOp } from './registry'

type Json = Record<string, unknown>

const asJson = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})

const typeOf = (schema: Json): string => {
  if (schema.type === 'array') return `${typeOf(asJson(schema.items))}[]`
  if (Array.isArray(schema.enum)) return 'enum'
  if (schema.type === 'object' && !schema.properties) return 'object'
  return typeof schema.type === 'string' ? schema.type : 'any'
}

const bound = (schema: Json, keys: string[]): number | undefined => {
  for (const key of keys) if (typeof schema[key] === 'number') return schema[key] as number
  return undefined
}

/** An object schema's properties as arguments, in declaration order. */
export function argumentsOf(schema: Json): McpArgumentInfo[] {
  const properties = asJson(schema.properties)
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  return Object.entries(properties).map(([name, value]) => {
    const property = asJson(value)
    // An array's own description and bounds; its items' type, values and fields.
    const item = property.type === 'array' ? asJson(property.items) : property
    const min = bound(property, ['minimum', 'minLength', 'minItems'])
    const max = bound(property, ['maximum', 'maxLength', 'maxItems'])
    const fields = item.type === 'object' && item.properties ? argumentsOf(item) : undefined
    return {
      name,
      type: typeOf(property),
      required: required.has(name),
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
      ...(Array.isArray(item.enum) ? { values: item.enum as string[] } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(fields?.length ? { fields } : {})
    }
  })
}

export const toolInfo = (op: RegisteredOp): McpToolInfo => ({
  name: op.name,
  mcpName: op.mcpName,
  domain: op.name.split('.')[0],
  summary: op.summary,
  ...(op.guidance ? { guidance: op.guidance } : {}),
  scope: op.scope,
  mutates: op.mutates,
  arguments: argumentsOf(op.inputSchema),
  examples: op.examples
})
