/**
 * The symbol records this project can see.
 *
 * The system+global index unioned with the open project's own libraries, the
 * project copy winning a lib_id clash — the same union the renderer builds
 * (`lib/libraryIndex.ts`), for the same reason: a symbol the design carries IS
 * the definition for that id, and an agent offered the standard one instead
 * would place a part that renders differently from every other instance of it
 * on the sheet.
 */
import type { IndexRecord } from '../libraryIndexTypes'
import { callerOf, type OpContext } from './context'
import { fail, nearest, refused, type OpFailure, type OpOutcome } from './errors'

export const libraryRecords = async (ctx: OpContext): Promise<IndexRecord[] | null> => {
  if (!ctx.library) return null
  const system = await ctx.library.system()
  const projectPath = ctx.project?.(callerOf(ctx)) ?? null
  const project = projectPath ? ctx.library.project(projectPath) : []
  if (!project.length) return system
  const byId = new Map(system.map((record) => [`${record.type}:${record.id}`, record]))
  for (const record of project) byId.set(`${record.type}:${record.id}`, record)
  return [...byId.values()]
}

/** No index at all is our gap, not the caller's — and guessing past it is worse
 *  than stopping, because a lib_id that exists but is wrong fails silently. */
export const LIBRARY_UNAVAILABLE: OpOutcome = fail({
  code: 'internal',
  kind: 'library-index-unavailable',
  message: 'The symbol library index is not available in this build of the server.',
  fix: 'Report it to the user; do not guess symbol names.'
})

/**
 * A `Footprint` field must name a footprint some library has.
 *
 * A name guessed from a directory listing otherwise surfaces only in kicad-cli.
 * Refused before the write, with the nearest real ids. When there is
 * no index to check against nothing is refused: an unverifiable field is not a
 * wrong one, and the fab export reports it later.
 */
export const footprintVeto = async (
  ctx: OpContext,
  footprint: string | undefined
): Promise<OpFailure | null> => {
  if (!footprint) return null
  const records = await libraryRecords(ctx)
  if (!records) return null
  const ids = records.filter((record) => record.type === 'footprint').map((record) => record.id)
  if (!ids.length || ids.includes(footprint)) return null
  return refused(
    `No footprint library has "${footprint}", so nothing was written.`,
    'Pass a "Nickname:Name" id as footprint_search or footprint_list_library reports it: one of the candidates, or search the package name.',
    { kind: 'unknown-footprint', candidates: nearest(footprint, ids, 5) }
  )
}
