import { footprintTransform, tfPoint } from '../../../schematic/placement'
import { hasCopper, netTieGroups, padProblems } from '../../../footprint/footprintChecks'
import { padProperty } from '../../../footprint/klc'
import type { KicadFootprint } from '../../../kicad/footprint'
import type { DrcContext } from '../context'
import { worldOf } from '../shared'

/**
 * What KiCad checks of each footprint on its own (`FOOTPRINT::CheckPads`,
 * `CheckFootprintAttributes`, `CheckNetTiePadGroups`, and the courtyard
 * provider's missing courtyard): its pads' padstacks, a type that disagrees
 * with its pads, a net-tie group naming a pad it lacks, and no courtyard.
 * The pad checks are the footprint checker's (`footprintChecks.ts`).
 */
export function* footprints(ctx: DrcContext): Generator<void> {
  const { board, one, footprintSubject, padSubject, courtyards, tick, near } = ctx
  for (let fp = 0; fp < board.footprints.length; fp++) {
    if (tick()) yield
    const bfp = board.footprints[fp]
    const footprint = bfp.footprint
    const subject = footprintSubject(bfp)
    const position = worldOf(bfp.position)
    const courtyard = courtyards[fp]
    const box = courtyard?.box ?? {
      minX: position.x,
      minY: position.y,
      maxX: position.x,
      maxY: position.y
    }
    const tf = footprintTransform(bfp)
    let padBox = box
    const pads = footprint.pads.map((pad) => {
      const center = tfPoint(tf, pad.position.x, pad.position.y)
      padBox = {
        minX: Math.min(padBox.minX, center.x),
        minY: Math.min(padBox.minY, center.y),
        maxX: Math.max(padBox.maxX, center.x),
        maxY: Math.max(padBox.maxY, center.y)
      }
      return { pad, center }
    })
    if (!near(padBox)) continue

    const likely = likelyType(footprint)
    const set = footprint.attributes.includes('smd')
      ? 'smd'
      : footprint.attributes.includes('through_hole')
        ? 'through_hole'
        : null
    if (set && likely && set !== likely)
      one(
        'part-type-mismatch',
        'warning',
        `${subject.name} is marked ${set === 'smd' ? 'SMD' : 'through hole'}, but its pads make it ${likely === 'smd' ? 'SMD' : 'through hole'}.`,
        subject,
        position,
        [box]
      )

    for (const { pad, center } of pads) {
      const { padstack, invalid, noHole } = padProblems(pad)
      const padSubjectOf = padSubject(bfp, pad, center)
      const at = [{ minX: center.x, minY: center.y, maxX: center.x, maxY: center.y }]
      // One finding per problem, on each padstack layer it is found on, as KiCad reports them.
      for (const problem of invalid)
        one(
          'padstack-invalid',
          'error',
          `${padSubjectOf.name}: ${problem}.`,
          padSubjectOf,
          center,
          at,
          undefined,
          {
            detail: problem
          }
        )
      if (noHole)
        one(
          'through-hole-pad-without-hole',
          'error',
          `${padSubjectOf.name} is a through-hole pad with no drill.`,
          padSubjectOf,
          center,
          at
        )
      for (const problem of padstack)
        one(
          'padstack',
          'warning',
          `${padSubjectOf.name}: ${problem}.`,
          padSubjectOf,
          center,
          at,
          undefined,
          {
            detail: problem
          }
        )
    }

    const groups = netTieGroups(footprint)
    if (groups.size) {
      const numbers = new Set(footprint.pads.map((pad) => pad.number))
      for (const number of groups.keys())
        if (!numbers.has(number))
          one(
            'footprint',
            'error',
            `A net-tie pad group of ${subject.name} names pad ${number}, which it does not have.`,
            subject,
            position,
            [box]
          )
    }

    if (
      courtyard &&
      !courtyard.malformed.front &&
      !courtyard.malformed.back &&
      courtyard.front.length === 0 &&
      courtyard.back.length === 0 &&
      !footprint.attributes.includes('allow_missing_courtyard')
    )
      one('no-courtyard', 'warning', `${subject.name} has no courtyard.`, subject, position, [box])
  }
}

/**
 * KiCad's `GetLikelyAttribute`: through hole with any plated hole, else SMD
 * with any copper SMD pad; fiducials, heatsinks, castellated and mechanical
 * pads don't count.
 */
function likelyType(footprint: KicadFootprint): 'smd' | 'through_hole' | null {
  let smd = 0
  let tht = 0
  for (const pad of footprint.pads) {
    const property = padProperty(pad._raw)
    if (
      property === 'pad_prop_fiducial_glob' ||
      property === 'pad_prop_fiducial_loc' ||
      property === 'pad_prop_heatsink' ||
      property === 'pad_prop_castellated' ||
      property === 'pad_prop_mechanical'
    )
      continue
    if (pad.type === 'thru_hole') tht++
    else if (pad.type === 'smd' && hasCopper(pad)) smd++
  }
  return tht > 0 ? 'through_hole' : smd > 0 ? 'smd' : null
}
