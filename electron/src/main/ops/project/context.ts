/**
 * `project.context` — the standing constraints, read verbatim.
 *
 * GoatCAD parses nothing here:
 * the reader is a model, and parsing would buy nothing while costing a YAML
 * dependency.
 */
import { contextGuidance, INTENT_FILE, readProjectContext } from '../../partsMcpProject'
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed } from '../errors'
import { callerOf } from '../context'
import { designAnswer } from '../design'

export const projectContext = defineOp({
  name: 'project.context',
  scope: 'app',
  mutates: false,
  summary:
    "Read the workspace project's board-intent.md: purpose, assembly, quantity, sourcing, budget and conventions.",
  guidance:
    'Call before recommending parts and before the first design edit: assembly method and quantity decide packages and price breaks, and the conventions say how sheets are drawn and parts chosen. The content is returned verbatim. A missing file means the constraints are unwritten, not absent; say that anything you assume is a guess. missingSections lists the conventions headings the file lacks; agentsHasSection is whether AGENTS.md in the project root links board-intent.md.',
  input: s.object({}),
  run(_args, ctx) {
    const resolved = ctx.workspaces?.resolve(callerOf(ctx))
    if (resolved && !resolved.ok) return designAnswer(resolved)
    const context = ctx.project
      ? readProjectContext(() => ctx.project?.(callerOf(ctx)) ?? null)
      : {
          projectPath: null,
          intentPath: null,
          exists: false,
          content: null,
          modifiedAt: null,
          problem: 'no-project' as const,
          agentsPath: null,
          agentsExists: false,
          agentsHasSection: false,
          missingSections: null
        }

    return succeed({
      projectPath: context.projectPath,
      intentFile: context.intentPath,
      exists: context.exists,
      modifiedAt: context.modifiedAt,
      // Verbatim: the reader is a model, and parsing would buy nothing while
      // costing a YAML dependency (workstream §7.5).
      content: context.content,
      missingSections: context.missingSections,
      agentsFile: context.agentsPath,
      agentsExists: context.agentsExists,
      agentsHasSection: context.agentsHasSection,
      guidance: contextGuidance(context),
      // Named so an agent writing the file for the first time puts it in the
      // right place without being told twice.
      fileName: INTENT_FILE
    })
  }
})
