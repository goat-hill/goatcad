/**
 * GUIDE.md, written beside the Python client: the client's spec in a few
 * thousand tokens, where `goatcad.py` itself runs to some seventy thousand. And
 * INIT.md, the method for starting a project, kept apart because it is needed
 * once per project and would double the guide (over MCP it is the `init`
 * prompt, which costs nothing until someone invokes it).
 *
 * An agent that reaches GoatCAD through MCP is told how to work by the server's
 * instructions and sees every tool's name; one that reaches it through Python
 * has only the generated module, and will not read all of it. This is the
 * difference made up, so that no operation goes unused because its name did not
 * suggest it: every operation, its arguments in the order its method takes them,
 * and its summary.
 *
 * Nothing in either is written twice. The working method is the MCP instructions
 * (`partsMcp.ts`) and INIT.md the `init` prompt's own text, both respelled for
 * Python; the operations come from the registry, their arguments from
 * `methodParams`, the order the client's signatures use.
 */
import { INSTRUCTIONS } from './partsMcp'
import { INIT_PROJECT_PROMPT } from './partsMcpPrompts'
import { methodParams } from './ops/pythonClient'
import type { RegisteredOp } from './ops/registry'

/** Where the `init` prompt is written beside the guide. */
export const PYTHON_INIT_FILE = 'INIT.md'

/** Every call takes it, and `connect(workspace=…)` sets it for all of them, so no line lists it. */
const IMPLICIT = 'workspace'

/**
 * MCP spelling to Python's: `schematic_place_symbol` → `gc.schematic.place_symbol`,
 * `parts_*` → `gc.parts.*`, `*_check` → `gc.*.check`. Longest names first, so a
 * name that is a prefix of another never takes part of it.
 */
export const pythonSpelling = (text: string, ops: readonly RegisteredOp[]): string => {
  const domains = new Set(ops.map((op) => op.name.split('.')[0]))
  const byLength = [...ops].sort((a, b) => b.mcpName.length - a.mcpName.length)
  let out = text
  for (const op of byLength)
    out = out.replace(new RegExp(`\\b${op.mcpName}\\b`, 'g'), `gc.${op.name}`)
  return out
    .replace(/\b([a-z]+)_\*/g, (match, domain: string) =>
      domains.has(domain) ? `gc.${domain}.*` : match
    )
    .replace(/\*_([a-z]+)\b/g, 'gc.*.$1')
}

/** One line per operation: `gc.domain.verb(required, optional?): summary`. */
const signature = (op: RegisteredOp): string => {
  const params = methodParams(op)
    .filter((param) => param.name !== IMPLICIT)
    .map((param) => (param.optional ? `${param.name}?` : param.name))
  return `gc.${op.name}(${params.join(', ')}): ${op.summary}`
}

export const renderPythonGuide = (ops: readonly RegisteredOp[], pythonPath: string): string => {
  const domains = new Map<string, RegisteredOp[]>()
  for (const op of ops) {
    const domain = op.name.split('.')[0]
    domains.set(domain, [...(domains.get(domain) ?? []), op])
  }
  // Respelled whole: summaries name other operations too, as MCP tools.
  const text = [
    '# GoatCAD from Python',
    '',
    `The spec of \`goatcad.py\` beside this file, in a few thousand tokens: how to work, and every operation with its arguments. The module itself is the full detail, generated from the same registry; \`gc.describe("schematic.place_symbol")\` returns one operation's guidance, schema and examples, and \`help(gc.schematic.place_symbol)\` its docstring.`,
    '',
    '```python',
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(pythonPath)})`,
    'from goatcad import connect',
    'gc = connect(workspace="ws_…")  # every call below then acts in that workspace',
    '```',
    '',
    `The app must be running (with a window, or \`goatcad --background\`). Every operation also takes \`${IMPLICIT}\`, which \`connect\` sets; an argument marked \`?\` is optional.`,
    '',
    '## How to work',
    '',
    INSTRUCTIONS,
    '',
    '## Operations',
    '',
    ...[...domains].flatMap(([domain, members]) => [
      `### ${domain}`,
      '',
      '```',
      ...members.map(signature),
      '```',
      ''
    ]),
    '## Starting a project',
    '',
    `When the project has no board-intent.md (\`gc.project.context()\` says), or the user asks to set up its design context, follow ${PYTHON_INIT_FILE} beside this file before the first design edit.`,
    ''
  ].join('\n')
  return pythonSpelling(text, ops)
}

/** INIT.md: the `init` prompt as written, respelled for Python. */
export const renderPythonInit = (ops: readonly RegisteredOp[]): string =>
  pythonSpelling(INIT_PROJECT_PROMPT.render({}), ops) + '\n'
