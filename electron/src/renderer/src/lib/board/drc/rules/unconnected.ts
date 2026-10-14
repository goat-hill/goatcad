import { allZones } from '../../../kicad/board'
import { type AirwireRef } from '../../boardConnectivity'
import type { DrcContext } from '../context'
import { at, type Subject, refKey } from '../shared'

export function* unconnected(ctx: DrcContext): Generator<void> {
  const { emit, netName, zoneSubject, pair, itemByRef, subjectOfItem, board, connectivity, tick } =
    ctx
  if (connectivity) {
    const subjectOfRef = (ref: AirwireRef): Subject => {
      if (ref.type === 'zone') return zoneSubject(allZones(board)[ref.index])
      return (
        subjectOfItem(itemByRef.get(refKey(ref))) ?? {
          item: `${ref.type}:${ref.index}`,
          name: ref.type,
          targets: []
        }
      )
    }
    for (const wire of connectivity.airwires) {
      if (tick()) yield
      const a = subjectOfRef(wire.fromRef)
      const b = subjectOfRef(wire.toRef)
      emit(
        {
          code: 'unconnected-items',
          severity: 'error',
          message: `${a.name} and ${b.name} on ${netName(wire.net)} are not connected.`,
          // The net beside the pair, as a short names its nets: the panel's row and the answer's finding alike.
          detail: netName(wire.net),
          position: at(wire.from),
          ...pair(a, b)
        },
        []
      )
    }
  }
}
