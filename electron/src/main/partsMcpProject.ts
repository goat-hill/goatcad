/**
 * Where the project is, and what its intent file says.
 *
 * The whole of this module is one division of labor made concrete:
 *
 * > GoatCAD supplies what an agent cannot get for itself — live distributor
 * > data, and where the project is. The agent supplies what it is already good
 * > at — reading files, writing prose, and holding a conversation.
 *
 * So this **reads and never writes**, and it returns the intent file as **raw
 * text rather than parsed fields**. The consumer is a language model, which
 * reads markdown and YAML natively; parsing would buy nothing today and would
 * cost a YAML dependency main does not have. GoatCAD parses this file on the
 * day it acts on the fields itself, and not before.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promptCommand } from './partsMcpClients'
import { CONVENTIONS_SECTIONS, INIT_PROJECT_PROMPT } from './partsMcpPrompts'

const INIT_COMMAND = promptCommand(INIT_PROJECT_PROMPT.name)

/** The file the intent lives in, in the project root. */
export const INTENT_FILE = 'board-intent.md'

/** The agent instructions file `init` writes its GoatCAD section into, in the project root. */
export const AGENTS_FILE = 'AGENTS.md'

/** Beyond this a file is not an intent document, and reading it into a model's
 *  context would be a way to spend someone's window on someone's mistake. */
const MAX_INTENT_BYTES = 256 * 1024

export interface ProjectContext {
  /** Null when no window has a project open — the app can run with none. */
  projectPath: string | null
  intentPath: string | null
  exists: boolean
  /** The file verbatim. Unparsed on purpose (see the module note). */
  content: string | null
  /** Epoch ms, so an agent can tell a stale answer from a fresh one. */
  modifiedAt: number | null
  /** Why there is nothing useful here, when there is nothing useful here. */
  problem: 'no-project' | 'not-created' | 'too-large' | 'unreadable' | null
  /** The project root's AGENTS.md; null with no project. */
  agentsPath: string | null
  agentsExists: boolean
  /** Whether AGENTS.md has the GoatCAD section `init` writes (see `linksIntent`). */
  agentsHasSection: boolean
  /** The `CONVENTIONS_SECTIONS` headings the intent file lacks; all of them
   *  when it does not exist, null when it could not be read. */
  missingSections: string[] | null
}

/**
 * The GoatCAD section's marker: a markdown link to the intent file, as
 * `[board-intent.md](board-intent.md)` or `(./board-intent.md#anchor)`. The
 * `init` prompt writes it; a mention without the link does not count.
 */
const INTENT_LINK = /\]\(\s*(?:\.\/)?board-intent\.md(?:#[^)\s]*)?\s*\)/

export const linksIntent = (agents: string): boolean => INTENT_LINK.test(agents)

/** A section is present when a heading line of any level reads as its name, case aside. */
export const missingConventionsSections = (intent: string): string[] => {
  const headings = new Set(
    intent
      .split(/\r?\n/)
      .map((line) => /^#{1,6}[ \t]+(.*?)[ \t#]*$/.exec(line)?.[1].toLowerCase())
      .filter((heading): heading is string => heading !== undefined)
  )
  return CONVENTIONS_SECTIONS.filter((name) => !headings.has(name.toLowerCase()))
}

const readAgents = (
  projectPath: string
): Pick<ProjectContext, 'agentsPath' | 'agentsExists' | 'agentsHasSection'> => {
  const agentsPath = join(projectPath, AGENTS_FILE)
  let size: number
  try {
    size = statSync(agentsPath).size
  } catch {
    return { agentsPath, agentsExists: false, agentsHasSection: false }
  }
  let agentsHasSection = false
  if (size <= MAX_INTENT_BYTES) {
    try {
      agentsHasSection = linksIntent(readFileSync(agentsPath, 'utf8'))
    } catch {
      // Unreadable (a directory, a permission): no section that can be read.
    }
  }
  return { agentsPath, agentsExists: true, agentsHasSection }
}

/** Injected: main owns window/session state, and this module stays Electron-free. */
export type ProjectResolver = () => string | null

export const readProjectContext = (resolve: ProjectResolver): ProjectContext => {
  const projectPath = resolve()
  if (!projectPath) {
    return {
      projectPath: null,
      intentPath: null,
      exists: false,
      content: null,
      modifiedAt: null,
      problem: 'no-project',
      agentsPath: null,
      agentsExists: false,
      agentsHasSection: false,
      missingSections: null
    }
  }

  const intentPath = join(projectPath, INTENT_FILE)
  const base = {
    projectPath,
    intentPath,
    exists: false,
    content: null,
    modifiedAt: null,
    ...readAgents(projectPath),
    missingSections: null
  }

  let size: number
  let modifiedAt: number
  try {
    const stats = statSync(intentPath)
    size = stats.size
    modifiedAt = stats.mtimeMs
  } catch {
    // Absent is the ordinary state before anyone has run the init prompt, and is
    // reported as its own problem rather than as an error.
    return { ...base, problem: 'not-created', missingSections: [...CONVENTIONS_SECTIONS] }
  }

  if (size > MAX_INTENT_BYTES) return { ...base, modifiedAt, problem: 'too-large' }

  try {
    const content = readFileSync(intentPath, 'utf8')
    return {
      ...base,
      exists: true,
      content,
      modifiedAt,
      problem: null,
      missingSections: missingConventionsSections(content)
    }
  } catch {
    return { ...base, modifiedAt, problem: 'unreadable' }
  }
}

/**
 * What to tell an agent about each state.
 *
 * **"Not created" must never read as "no constraints".** An empty answer is the
 * one an agent will happily proceed from, inventing the assembly method and the
 * build quantity that the project file exists to supply — which is precisely the
 * failure this feature was specced to fix.
 */
export const CONTEXT_GUIDANCE: Record<NonNullable<ProjectContext['problem']> | 'ok', string> = {
  ok: 'These are the standing constraints; its conventions sections are the house style for every schematic edit, footprint and part choice. Fields under `assumed` were inferred rather than stated: say so when you rely on one. When the user corrects a convention, offer to record it in the file.',
  'no-project':
    'No project is open in GoatCAD. Ask the user to open their project, or proceed on what they tell you and say which constraints you assume.',
  'not-created': `No board-intent.md yet, which is not the same as having no constraints: state any assembly, quantity, sourcing or budget you use as a guess, and draw to standard KiCad practice. Offer to run ${INIT_COMMAND} to record them.`,
  'too-large':
    'The intent file is too large and was not read. Tell the user; do not proceed as if there were no constraints.',
  unreadable:
    'The intent file could not be read. Tell the user; do not proceed as if there were no constraints.'
}

/** What `init` writes that this project lacks, appended to the `ok` guidance. */
const SETUP_INCOMPLETE = `missingSections and agentsHasSection say what ${INIT_COMMAND} writes that this project lacks: offer to run it, and until then draw to standard KiCad practice.`

export const contextGuidance = (context: ProjectContext): string => {
  const base = CONTEXT_GUIDANCE[context.problem ?? 'ok']
  const incomplete =
    context.problem === null &&
    (!context.agentsHasSection || (context.missingSections?.length ?? 0) > 0)
  return incomplete ? `${base} ${SETUP_INCOMPLETE}` : base
}

/**
 * The project's two footprint choices, read from the intent file's
 * frontmatter:
 *
 *   footprints:
 *     density: nominal      # least | nominal | most
 *     pin1_marker: chevron  # chevron | dot | line
 *
 * The one place main acts on a field of this file, so it reads exactly these
 * two keys (and `assembly.method`, which a missing density defaults from)
 * rather than taking a YAML dependency. A value outside its list is ignored.
 */
export interface FootprintStyle {
  density: 'least' | 'nominal' | 'most'
  pin1Marker: 'chevron' | 'dot' | 'line'
  source: 'board-intent' | 'default'
}

const DENSITIES = ['least', 'nominal', 'most'] as const
const MARKERS = ['chevron', 'dot', 'line'] as const

/** The keys of one top-level block of YAML frontmatter, values unquoted. */
const frontmatterBlock = (content: string, block: string): Map<string, string> => {
  const out = new Map<string, string>()
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return out
  let inside = false
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    if (/^\S/.test(line)) {
      inside = new RegExp(`^${block}:\\s*$`).test(line)
      continue
    }
    const pair = inside ? /^\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line) : null
    if (pair) out.set(pair[1], pair[2].replace(/^["']|["']$/g, ''))
  }
  return out
}

export const readFootprintStyle = (content: string | null): FootprintStyle => {
  const footprints = content ? frontmatterBlock(content, 'footprints') : new Map<string, string>()
  const assembly = content ? frontmatterBlock(content, 'assembly') : new Map<string, string>()
  const density = DENSITIES.find((value) => value === footprints.get('density'))
  const pin1Marker = MARKERS.find((value) => value === footprints.get('pin1_marker'))
  return {
    density: density ?? (assembly.get('method') === 'hand-solder' ? 'most' : 'nominal'),
    pin1Marker: pin1Marker ?? 'chevron',
    source: density || pin1Marker ? 'board-intent' : 'default'
  }
}
