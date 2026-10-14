/**
 * The registry, rendered as a Python module.
 *
 * Generated rather than hand-written for the reason RULES.md gives about docs: one
 * fact, one home. The guidance paragraph a model reads before calling an
 * operation is written once, in the operation, and reaches an MCP tool
 * description, `/v1/ops`, and this docstring from there. Hand-maintaining
 * twenty-odd Python methods beside it would mean the two drift the first time
 * somebody improves a sentence.
 *
 * **Argument names are the wire names, not Python's.** `libId`, not `lib_id`.
 * That is a deliberate loss of PEP 8: the same identifier then appears in the
 * MCP tool, the JSON schema, the `path` of an `invalid-args` error, and the
 * Python call — and §4's whole discipline is that a model reads a name rather
 * than recalling it. Two spellings for one argument is exactly the thing that
 * makes it guess.
 *
 * The behavior lives in `pythonRuntime.ts`; this file only renders the typed
 * surface on top of it and glues the two together.
 */
import { PYTHON_CHUNKED_READS, PYTHON_RUNTIME, PYTHON_WHOLE_READS } from './pythonRuntime'
import type { RegisteredOp } from './registry'

/** JSON Schema fragment to a Python annotation. */
const annotation = (schema: Record<string, unknown>): string => {
  const values = schema.enum
  if (Array.isArray(values)) {
    return `Literal[${values.map((value) => JSON.stringify(value)).join(', ')}]`
  }
  switch (schema.type) {
    case 'string':
      return 'str'
    case 'integer':
      return 'int'
    case 'number':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'array': {
      const items = schema.items
      return `list[${items && typeof items === 'object' ? annotation(items as Record<string, unknown>) : 'Any'}]`
    }
    case 'object': {
      const extra = schema.additionalProperties
      // An open map carries its value type; a closed object is a shape this
      // generator does not model, and `dict[str, Any]` says so honestly rather
      // than inventing a TypedDict nobody validated.
      return extra && typeof extra === 'object'
        ? `dict[str, ${annotation(extra as Record<string, unknown>)}]`
        : 'dict[str, Any]'
    }
    default:
      return 'Any'
  }
}

/**
 * Wrap prose for a docstring, at the width the rest of the file uses.
 *
 * `hang` indents every line after the first, which is what makes a wrapped
 * argument description read as one entry rather than as new prose.
 */
const wrap = (text: string, width: number, indent: string, hang = ''): string[] => {
  const lines: string[] = []
  let current = ''
  const prefix = (): string => (lines.length === 0 ? indent : indent + hang)
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && `${current} ${word}`.length + prefix().length > width) {
      lines.push(prefix() + current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(prefix() + current)
  return lines
}

/** Safe inside a `"""` docstring: no stray triple quote, no trailing quote that
 *  would run into the closing one. */
const docSafe = (text: string): string => {
  const cleaned = text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
  return cleaned.endsWith('"') ? `${cleaned} ` : cleaned
}

/**
 * A JSON value as Python source.
 *
 * Examples exist to be copied — §3 is explicit that a model copies one far more
 * reliably than it composes from a schema — so an example that has to be
 * translated from JSON first is doing half its job.
 */
const literal = (value: unknown): string => {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${JSON.stringify(key)}: ${literal(entry)}`)
    .join(', ')}}`
}

const className = (domain: string): string =>
  `${domain.charAt(0).toUpperCase()}${domain.slice(1)}Ops`

/** Required arguments a transaction fills from its own, so optional on a method. */
const FILLED: ReadonlySet<string> = new Set(['viewport', 'action'])

/**
 * A method's keyword arguments, in the order its signature takes them: required
 * first, then optional, since Python needs defaults last and a reader scanning a
 * signature wants the mandatory ones at the front anyway. A required viewport or
 * action counts as optional: inside a transaction the transaction's own fills it,
 * and outside one the app refuses a call without it. The guide lists the same
 * signature (`pythonGuide.ts`).
 */
export const methodParams = (op: RegisteredOp): Array<{ name: string; optional: boolean }> => {
  const properties = (op.inputSchema.properties as Record<string, unknown>) ?? {}
  const required = new Set((op.inputSchema.required as string[]) ?? [])
  const optional = (name: string): boolean => !required.has(name) || FILLED.has(name)
  return Object.keys(properties)
    .sort((a, b) => Number(optional(a)) - Number(optional(b)))
    .map((name) => ({ name, optional: optional(name) }))
}

const renderMethod = (op: RegisteredOp): string => {
  const verb = op.name.split('.')[1]
  const properties = (op.inputSchema.properties as Record<string, Record<string, unknown>>) ?? {}
  const required = new Set((op.inputSchema.required as string[]) ?? [])
  const signature = methodParams(op)
  const names = signature.map((param) => param.name)
  const params = signature.map(({ name, optional }) => {
    const type = annotation(properties[name])
    return optional ? `        ${name}: ${type} | None = None,` : `        ${name}: ${type},`
  })
  // A list a script reads whole: a client-side flag, snake_case as the
  // transaction's are, so it never reads as a wire argument.
  const whole = PYTHON_WHOLE_READS.has(op.name)
  if (whole) params.push('        truncated_ok: bool = False,')
  // A by-id read past its cap is split into calls of the cap each.
  const chunkKey = PYTHON_CHUNKED_READS.get(op.name)
  const chunk = chunkKey ? (properties[chunkKey] as { maxItems?: number }).maxItems : undefined

  // A summary that fits opens on the quotes, as PEP 257 expects; one that does
  // not is wrapped rather than left as a 200-character line nobody can read.
  const summary = docSafe(op.summary)
  const doc: string[] =
    summary.length <= 80
      ? [`        """${summary}`]
      : ['        """', ...wrap(summary, 88, '        ')]
  if (op.guidance) {
    doc.push('')
    doc.push(...wrap(docSafe(op.guidance), 88, '        '))
  }
  for (const name of names) {
    const described = properties[name].description
    if (typeof described !== 'string') continue
    if (doc[doc.length - 1] !== '') doc.push('')
    const filled =
      FILLED.has(name) && required.has(name)
        ? ` Required, except inside a transaction, whose ${name} fills it.`
        : ''
    doc.push(...wrap(`${name}: ${docSafe(described)}${filled}`, 88, '        ', '    '))
  }
  if (whole) {
    if (doc[doc.length - 1] !== '') doc.push('')
    doc.push(
      ...wrap(
        'Without limit or offset, every match is read, page by page at one revision; with either, one page, and a truncated one raises Truncated unless truncated_ok=True.',
        88,
        '        '
      )
    )
  }
  if (chunkKey && chunk) {
    if (doc[doc.length - 1] !== '') doc.push('')
    doc.push(
      ...wrap(
        `Any number of ${chunkKey}: past ${chunk}, they are read ${chunk} per call and joined in order. The calls may answer at different revisions if the document changes between them; the joined answer then has no revision.`,
        88,
        '        '
      )
    )
  }
  for (const example of op.examples) {
    doc.push('')
    doc.push(...wrap(`Example (${docSafe(example.note)}):`, 88, '        '))
    const kwargs = Object.entries(example.args)
      .map(([key, value]) => `${key}=${literal(value)}`)
      .join(', ')
    doc.push(`            ${verb}(${kwargs})`)
  }
  doc.push('        """')

  const payload = names.length ? `{${names.map((name) => `"${name}": ${name}`).join(', ')}}` : '{}'

  // The signature is keyword-only. §10 allows a new optional argument on a
  // shipped verb, and positional arguments would make that a breaking change
  // the moment one landed in the middle.
  return [
    `    def ${verb}(`,
    '        self,',
    // The bare `*` only makes sense with something after it, and an operation
    // that takes no arguments is common here (`parts.status`, `project.context`).
    ...(params.length ? ['        *,', ...params] : []),
    '    ) -> Any:',
    ...doc,
    whole
      ? `        return self._client._read_whole("${op.name}", ${payload}, truncated_ok)`
      : chunkKey && chunk
        ? `        return self._client._read_chunked("${op.name}", ${payload}, "${chunkKey}", ${chunk})`
        : `        return self._client._dispatch("${op.name}", ${payload}, ${op.mutates ? 'True' : 'False'})`
  ].join('\n')
}

/**
 * Render the whole module.
 *
 * `configDir` is baked in so `connect()` needs no arguments: the app knows where
 * it just wrote this file, and a script that has to be told where to look is a
 * script somebody had to configure.
 */
export const renderPythonClient = (ops: readonly RegisteredOp[], configDir: string): string => {
  const domains = new Map<string, RegisteredOp[]>()
  for (const op of ops) {
    const domain = op.name.split('.')[0]
    const bucket = domains.get(domain)
    if (bucket) bucket.push(op)
    else domains.set(domain, [op])
  }

  const classes = [...domains.entries()].map(([domain, members]) =>
    [
      `class ${className(domain)}:`,
      `    """The \`${domain}\` operations."""`,
      '',
      '    def __init__(self, client: "GoatCAD") -> None:',
      '        self._client = client',
      '',
      members.map(renderMethod).join('\n\n')
    ].join('\n')
  )

  // What each document batch holds, read from the batch ops themselves: a
  // transaction queues exactly these.
  const batchOps = ops
    .filter((op) => op.batchOps)
    .map((op) => `    "${op.name}": {${op.batchOps!.map((name) => `"${name}"`).join(', ')}},`)
    .join('\n')

  const registryMap = [...domains.keys()]
    .map((domain) => `    "${domain}": ${className(domain)},`)
    .join('\n')

  return [
    '"""GoatCAD — drive the running app from Python.',
    '',
    ...wrap(
      'Written by GoatCAD itself into its own config directory, so there is nothing to install and this file always matches the app that wrote it. It uses the standard library only; for numpy or any other package, run the script in your own virtual environment and import this file there. Import it by putting its directory on the path:',
      88,
      ''
    ),
    '',
    '    import sys',
    `    sys.path.insert(0, ${JSON.stringify(configDir + '/python')})`,
    '    from goatcad import connect',
    '',
    '    gc = connect()',
    '    print(gc.schematic.describe())',
    '',
    ...wrap(
      'GENERATED FILE — do not edit. It is rewritten every time the app starts, from the operation registry in electron/src/main/ops/. Argument names are the wire names (libId, not lib_id) on purpose: the same identifier appears here, in the JSON schema, and in any error about it.',
      88,
      ''
    ),
    '"""',
    '',
    `_WRITTEN_CONFIG_DIR = ${JSON.stringify(configDir)}`,
    '',
    PYTHON_RUNTIME,
    '',
    '',
    classes.join('\n\n\n'),
    '',
    '',
    '_DOMAINS = {',
    registryMap,
    '}',
    '',
    '_BATCH_OPS = {',
    batchOps,
    '}',
    ''
  ].join('\n')
}
