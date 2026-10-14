import type { DrcContext } from '../context'

export function* isolatedCopper(ctx: DrcContext): Generator<void> {
  const { sliceDone, one, fills, islandOf, connectivity } = ctx
  if (connectivity) {
    const netless = new Set<string>()
    for (const fill of fills) {
      if (sliceDone()) yield
      if (fill.teardrop) continue
      let isolated: boolean
      if (fill.net > 0) {
        isolated = islandOf.get(`${fill.zoneIndex}:${fill.polyIndex}`)?.orphaned ?? false
      } else {
        const key = `${fill.zoneIndex}:${fill.layer}`
        isolated = !netless.has(key)
        netless.add(key)
      }
      if (!isolated) continue
      one(
        'isolated-copper',
        'warning',
        `An island of ${fill.subject.name} on ${fill.layer} connects to no pad. Remove islands in the zone's settings, or connect it.`,
        fill.subject,
        fill.ring[0]
      )
    }
  }
}
