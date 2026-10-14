/**
 * The agent's door to Schematic Setup: the ERC's rule severities, read and
 * written, and its KiCad exclusions, read — the page's two sections, in the
 * shape `boardSetup.ts` gives Board Setup's.
 *
 * A severity write patches the project file the page patches
 * (`patchRuleSeverities`) and announces it the same way, so every open sheet
 * reloads it; with `checks`, the answer's delta is the root sheet's own
 * findings before and after, which are what the page and the pill count.
 */
import type {
  McpDesignRequest,
  McpGetSchematicSetupRequest,
  McpUpdateSchematicSetupRequest
} from '../../../../preload/mcpTypes'
import { extractRuleSeverities, patchRuleSeverities } from '../kicad/project'
import { activeFindings, extractExclusions } from '../kicadExclusions'
import { ERC_CATALOG } from './ercCatalog'
import { checkDelta, compactDelta, type CheckResult } from './checks'
import {
  exclusionsRecord,
  planSeverities,
  severitiesRecord,
  severityCounts
} from '../board/boardSetup'

type SetupRequest = McpGetSchematicSetupRequest | McpUpdateSchematicSetupRequest

export const isSchematicSetupRequest = (request: McpDesignRequest): request is SetupRequest =>
  request.kind === 'get-schematic-setup' || request.kind === 'update-schematic-setup'

/** The root sheet's findings as the pill ranks them, and the reload that re-reads the project. */
export interface SetupSheet {
  checks(): CheckResult[]
  reloadHierarchy(): Promise<void>
}

export interface SchematicSetupContext {
  /** The active project's `.kicad_pro`, or null. */
  projectFile(): string | null
  readText(path: string): Promise<string | null>
  /** Write the project file and tell every open view it changed. */
  writeProject(path: string, content: string): Promise<boolean>
  /** The root sheet's session, or null when the project has no schematic. */
  rootSheet(): Promise<SetupSheet | null>
}

export const createSchematicSetupAgent = (
  ctx: SchematicSetupContext
): { dispatch(request: SetupRequest): Promise<unknown> } => {
  const read = async (): Promise<
    { file: string; text: string } | { error: string; detail: string }
  > => {
    const file = ctx.projectFile()
    if (!file)
      return {
        error: 'no-project',
        detail: 'No project is open; project_open one first.'
      }
    const text = await ctx.readText(file)
    return text === null
      ? { error: 'write-failed', detail: `${file} could not be read.` }
      : { file, text }
  }

  const get = async (request: McpGetSchematicSetupRequest): Promise<unknown> => {
    const found = await read()
    if ('error' in found) return found
    const sections = request.sections?.length ? request.sections : ['severities', 'exclusions']
    const sheet = sections.includes('exclusions') ? await ctx.rootSheet() : null
    return {
      project: found.file,
      ...(sections.includes('severities')
        ? {
            severities: severitiesRecord(
              ERC_CATALOG,
              extractRuleSeverities(found.text, 'erc') ?? {}
            )
          }
        : {}),
      ...(sections.includes('exclusions')
        ? {
            exclusions: exclusionsRecord(
              extractExclusions(found.text, 'erc'),
              sheet?.checks() ?? null
            )
          }
        : {}),
      guidance:
        'schematic_update_setup takes severities in this shape. Exclusions are read-only (made in KiCad); hides counts the current findings each keeps out of schematic_check.'
    }
  }

  const update = async (request: McpUpdateSchematicSetupRequest): Promise<unknown> => {
    const found = await read()
    if ('error' in found) return found
    const extra = Object.keys(request.changes).filter((key) => key !== 'severities')
    if (extra.length)
      return {
        error: 'not-applicable',
        detail: extra.includes('exclusions')
          ? 'Exclusions are read-only; they are made in KiCad.'
          : `schematic_update_setup takes severities; not ${extra.join(', ')}.`
      }
    const planned = planSeverities(
      ERC_CATALOG,
      extractRuleSeverities(found.text, 'erc') ?? {},
      request.changes.severities
    )
    if (!planned.ok)
      return {
        error: planned.error,
        detail: planned.detail,
        ...(planned.candidates ? { candidates: planned.candidates } : {})
      }
    const patched = patchRuleSeverities(found.text, 'erc', planned.set)
    if (patched === null)
      return { error: 'write-failed', detail: `${found.file} could not be read as a project file.` }
    if (request.dryRun)
      return {
        project: found.file,
        dryRun: true,
        changed: { severities: Object.keys(planned.set) },
        before: { severities: planned.before },
        guidance: 'Nothing was written; send again without dryRun to apply it.'
      }
    const sheet = await ctx.rootSheet()
    const before = sheet && request.checks ? activeFindings(sheet.checks()) : null
    if (!(await ctx.writeProject(found.file, patched)))
      return { error: 'write-failed', detail: `${found.file} was not written.` }
    let checks: unknown
    let counts: unknown
    if (sheet && before) {
      await sheet.reloadHierarchy()
      const after = activeFindings(sheet.checks())
      checks = compactDelta(checkDelta(before, after))
      counts = { before: severityCounts(before), after: severityCounts(after) }
    }
    return {
      project: found.file,
      changed: { severities: Object.keys(planned.set) },
      before: { severities: planned.before },
      written: found.file,
      ...(checks ? { checks, counts } : {}),
      guidance: `Written to the project file, not undoable: send before back to revert. ${checks ? 'checks lists findings hidden or restored; counts shows the re-ranking.' : 'No checks ran; pass checks: true or call schematic_check.'}`
    }
  }

  return {
    dispatch: (request) => (request.kind === 'get-schematic-setup' ? get(request) : update(request))
  }
}
