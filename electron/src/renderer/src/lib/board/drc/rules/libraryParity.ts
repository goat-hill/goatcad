import type { KicadFootprint } from '../../../kicad/footprint'
import type { KicadBoardFootprint } from '../../../kicad/board'
import { libraryDifference } from '../../footprintParity'
import { splitFootprintId } from '../../boardLibraries'
import type { DrcContext } from '../context'
import { worldOf } from '../shared'

/** Each board footprint's comparison with a library copy, kept while neither changes. */
const compared = new WeakMap<KicadBoardFootprint, WeakMap<KicadFootprint, string | null>>()

/**
 * KiCad's library parity (`lib_footprint_issues`, `lib_footprint_mismatch`):
 * a footprint whose library the project does not reach, or which its library
 * lacks, and one that no longer matches its library copy
 * (`footprintParity.ts`). Quiet without the libraries, and for a library not
 * known yet.
 */
export function* libraryParity(ctx: DrcContext): Generator<void> {
  const { board, libraries, one, footprintSubject, tick } = ctx
  if (!libraries) return
  for (const bfp of board.footprints) {
    if (tick(16)) yield
    const id = splitFootprintId(bfp.libId)
    if (!id) continue
    const subject = footprintSubject(bfp)
    const position = worldOf(bfp.position)
    const box = [{ minX: position.x, minY: position.y, maxX: position.x, maxY: position.y }]
    const state = libraries.library(id.nickname)
    if (state === undefined) continue
    if (state !== 'ok') {
      const where = libraries.location?.(id.nickname)
      const message =
        state === 'missing'
          ? `${subject.name} comes from the footprint library '${id.nickname}', which the project's library tables do not include.`
          : state === 'disabled'
            ? `${subject.name} comes from the footprint library '${id.nickname}', which is disabled in the library tables.`
            : `${subject.name} comes from the footprint library '${id.nickname}', which was not found${where ? ` at '${where}'` : ''}.`
      one('library-footprint-issue', 'warning', message, subject, position, box)
      continue
    }
    const library = libraries.footprint(id.nickname, id.name)
    if (library === undefined) continue
    if (library === null) {
      one(
        'library-footprint-issue',
        'warning',
        `${subject.name}'s footprint '${id.name}' is not in the library '${id.nickname}'.`,
        subject,
        position,
        box
      )
      continue
    }
    let known = compared.get(bfp)
    if (!known) compared.set(bfp, (known = new WeakMap()))
    let difference = known.get(library)
    if (difference === undefined) {
      difference = libraryDifference(board, bfp, library)
      known.set(library, difference)
    }
    if (difference)
      one(
        'library-footprint-mismatch',
        'warning',
        `${subject.name} does not match '${id.name}' in the library '${id.nickname}': ${difference}. Update it from the library, or save it back.`,
        subject,
        position,
        box
      )
  }
}
