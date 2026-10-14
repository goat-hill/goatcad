/**
 * The schema DSL: one definition, three products.
 *
 * From a single `s.object({...})` this yields **the TypeScript type** a handler
 * receives (via `Infer`, so `args` is typed without a cast), **the JSON Schema**
 * published to MCP clients and `/v1/schema`, and **a validator** run in main
 * before anything crosses the bridge. Design: `docs/agent-api.md`,
 * which is also why this is ~250 hand-written lines rather than a
 * dependency: RULES.md §4 makes a package the maintainer's call, and the surface
 * an operation registry needs is small. If it outgrows a page, that is the
 * moment to ask, with the size as the evidence.
 *
 * Two rules the rest of the system leans on.
 *
 * **Every object is `additionalProperties: false`, and an unknown field is an
 * error rather than something ignored.** A silently dropped argument is a call
 * that succeeds with the wrong meaning, which is the one failure an agent
 * cannot see and will not retry.
 *
 * **Emptiness is not a schema concern.** A trimmed string that comes back empty
 * is a precondition the handler refuses with a `fix` naming what to do
 * (preconditions belong to the handler layer), not a `minLength` here — the
 * published schema stays the shape of the argument, not a restatement of the
 * op's rules.
 */

/** Where a value went wrong, as a JSON pointer, plus what was wrong with it. */
export interface SchemaIssue {
  path: string
  message: string
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issue: SchemaIssue }

export interface Schema<T> {
  /** The published JSON Schema fragment for this node. */
  readonly json: Record<string, unknown>
  readonly isOptional: boolean
  parse(value: unknown, path: string): ParseResult<T>
  describe(text: string): Schema<T>
  /** `minimum` on a number, `minLength` on a string, `minItems` on an array. */
  min(bound: number): Schema<T>
  max(bound: number): Schema<T>
  /** Trim on the way in. Applied where today's tools trim, and nowhere else —
   *  trimming a free-text field would silently edit the user's data. */
  trim(): Schema<T>
  optional(): OptionalSchema<T>
}

/** Branded so `Infer` can tell an optional property from a required one at the
 *  type level; there is no other way to split the keys of an object shape. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optionalBrand: true
  describe(text: string): OptionalSchema<T>
  min(bound: number): OptionalSchema<T>
  max(bound: number): OptionalSchema<T>
  trim(): OptionalSchema<T>
}

export type AnySchema = Schema<unknown>
export type Shape = Record<string, AnySchema>

export type Infer<S> = S extends Schema<infer T> ? T : never

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never
}[keyof S]
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>

/** Flattens the intersection so a handler's `args` reads as one object in an
 *  editor rather than as `A & B`. */
type Prettify<T> = { [K in keyof T]: T[K] } & {}

export type ObjectOf<S extends Shape> = Prettify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>

// --- the internal descriptor -------------------------------------------------

type Kind =
  'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object' | 'record' | 'json'

interface Def {
  kind: Kind
  description?: string
  min?: number
  max?: number
  trim?: boolean
  values?: readonly string[]
  item?: AnySchema
  shape?: Shape
  valueSchema?: AnySchema
}

const issue = (path: string, message: string): { ok: false; issue: SchemaIssue } => ({
  ok: false,
  issue: { path, message }
})

const toJson = (def: Def): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  switch (def.kind) {
    case 'string':
      out.type = 'string'
      if (def.min !== undefined) out.minLength = def.min
      if (def.max !== undefined) out.maxLength = def.max
      break
    case 'number':
    case 'integer':
      out.type = def.kind
      if (def.min !== undefined) out.minimum = def.min
      if (def.max !== undefined) out.maximum = def.max
      break
    case 'boolean':
      out.type = 'boolean'
      break
    case 'enum':
      out.type = 'string'
      out.enum = [...(def.values ?? [])]
      break
    case 'array':
      out.type = 'array'
      out.items = def.item?.json ?? {}
      if (def.min !== undefined) out.minItems = def.min
      if (def.max !== undefined) out.maxItems = def.max
      break
    case 'object': {
      out.type = 'object'
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, schema] of Object.entries(def.shape ?? {})) {
        properties[key] = schema.json
        if (!schema.isOptional) required.push(key)
      }
      out.properties = properties
      // Omitted rather than emitted empty: `required: []` is noise in every
      // no-argument tool's schema, and JSON Schema treats the two the same.
      if (required.length > 0) out.required = required
      out.additionalProperties = false
      break
    }
    case 'record':
      out.type = 'object'
      out.additionalProperties = def.valueSchema?.json ?? true
      break
    case 'json':
      // Deliberately unconstrained: the only caller is `batch`, whose entries
      // carry another operation's arguments. Those are validated by that
      // operation's own schema a moment later, and restating them here would
      // mean two definitions of one contract.
      out.type = 'object'
      break
  }
  if (def.description !== undefined) out.description = def.description
  return out
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseFor = (def: Def) => {
  return (value: unknown, path: string): ParseResult<unknown> => {
    switch (def.kind) {
      case 'string': {
        if (typeof value !== 'string') return issue(path, 'must be a string')
        const text = def.trim ? value.trim() : value
        if (def.min !== undefined && text.length < def.min) {
          return issue(path, `must be at least ${def.min} characters`)
        }
        if (def.max !== undefined && text.length > def.max) {
          return issue(path, `must be at most ${def.max} characters`)
        }
        return { ok: true, value: text }
      }
      case 'number':
      case 'integer': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return issue(path, 'must be a number')
        }
        if (def.kind === 'integer' && !Number.isInteger(value)) {
          return issue(path, 'must be a whole number')
        }
        if (def.min !== undefined && value < def.min)
          return issue(path, `must be at least ${def.min}`)
        if (def.max !== undefined && value > def.max)
          return issue(path, `must be at most ${def.max}`)
        return { ok: true, value }
      }
      case 'boolean':
        if (typeof value !== 'boolean') return issue(path, 'must be true or false')
        return { ok: true, value }
      case 'enum': {
        const values = def.values ?? []
        if (typeof value !== 'string' || !values.includes(value)) {
          return issue(path, `must be one of: ${values.join(', ')}`)
        }
        return { ok: true, value }
      }
      case 'array': {
        if (!Array.isArray(value)) return issue(path, 'must be an array')
        if (def.min !== undefined && value.length < def.min) {
          return issue(path, `must have at least ${def.min} ${def.min === 1 ? 'entry' : 'entries'}`)
        }
        if (def.max !== undefined && value.length > def.max) {
          return issue(path, `must have at most ${def.max} entries`)
        }
        const out: unknown[] = []
        for (let index = 0; index < value.length; index += 1) {
          const parsed = def.item?.parse(value[index], `${path}/${index}`)
          if (!parsed) return issue(path, 'has no item schema')
          if (!parsed.ok) return parsed
          out.push(parsed.value)
        }
        return { ok: true, value: out }
      }
      case 'object': {
        if (!isPlainObject(value)) return issue(path, 'must be an object')
        const shape = def.shape ?? {}
        const known = Object.keys(shape)
        for (const key of Object.keys(value)) {
          if (!(key in shape)) {
            // Named rather than dropped: a misspelled argument that is ignored
            // is a call that succeeds meaning something else.
            return issue(
              `${path}/${key}`,
              known.length > 0
                ? `unknown field. This operation accepts: ${known.join(', ')}.`
                : 'unknown field. This operation takes no arguments.'
            )
          }
        }
        const out: Record<string, unknown> = {}
        for (const [key, schema] of Object.entries(shape)) {
          const raw = value[key]
          if (raw === undefined) {
            if (schema.isOptional) continue
            return issue(`${path}/${key}`, 'is required')
          }
          const parsed = schema.parse(raw, `${path}/${key}`)
          if (!parsed.ok) return parsed
          if (parsed.value !== undefined) out[key] = parsed.value
        }
        return { ok: true, value: out }
      }
      case 'json':
        if (!isPlainObject(value)) return issue(path, 'must be an object')
        return { ok: true, value }
      case 'record': {
        if (!isPlainObject(value)) return issue(path, 'must be an object')
        const out: Record<string, unknown> = {}
        for (const [key, raw] of Object.entries(value)) {
          const parsed = def.valueSchema?.parse(raw, `${path}/${key}`)
          if (!parsed) return issue(path, 'has no value schema')
          if (!parsed.ok) return parsed
          out[key] = parsed.value
        }
        return { ok: true, value: out }
      }
    }
  }
}

/** Build a schema from a descriptor. Every chain method rebuilds rather than
 *  mutates, so a shared `s.string()` cannot be edited by one of its users. */
const build = <T>(def: Def, optional: boolean): Schema<T> => {
  const parse = parseFor(def)
  const self = {
    json: toJson(def),
    isOptional: optional,
    parse(value: unknown, path: string): ParseResult<T> {
      if (optional && value === undefined) return { ok: true, value: undefined as T }
      return parse(value, path) as ParseResult<T>
    },
    describe: (text: string) => build<T>({ ...def, description: text }, optional),
    min: (bound: number) => build<T>({ ...def, min: bound }, optional),
    max: (bound: number) => build<T>({ ...def, max: bound }, optional),
    trim: () => build<T>({ ...def, trim: true }, optional),
    optional: () => build<T>(def, true) as OptionalSchema<T>
  }
  return self as Schema<T>
}

export const s = {
  string: (): Schema<string> => build<string>({ kind: 'string' }, false),
  number: (): Schema<number> => build<number>({ kind: 'number' }, false),
  integer: (): Schema<number> => build<number>({ kind: 'integer' }, false),
  boolean: (): Schema<boolean> => build<boolean>({ kind: 'boolean' }, false),
  enum: <const V extends readonly string[]>(values: V): Schema<V[number]> =>
    build<V[number]>({ kind: 'enum', values }, false),
  array: <T>(item: Schema<T>): Schema<T[]> =>
    build<T[]>({ kind: 'array', item: item as AnySchema }, false),
  object: <S extends Shape>(shape: S): Schema<ObjectOf<S>> =>
    build<ObjectOf<S>>({ kind: 'object', shape }, false),
  /** An open map with a typed value — KiCad property bags, filter parameters. */
  record: <T>(value: Schema<T>): Schema<Record<string, T>> =>
    build<Record<string, T>>({ kind: 'record', valueSchema: value as AnySchema }, false),
  /** Any JSON object, checked no further here. For `batch`, which carries
   *  another operation's arguments and lets that operation validate them. */
  json: (): Schema<Record<string, unknown>> =>
    build<Record<string, unknown>>({ kind: 'json' }, false)
}
