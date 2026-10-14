/**
 * The board check modules, in the order they run (`drc/rules/`). A region
 * rule makes every finding round an edit from what lies there
 * (`drc/incremental.ts`); a board rule reads the whole board, so it runs once
 * edits settle.
 */
import type { DrcContext } from './context'
import { customRules } from './rules/customRules'
import { copperClearance } from './rules/copperClearance'
import { holeClearance } from './rules/holeClearance'
import { drawingClearance } from './rules/drawingClearance'
import { holeToHole } from './rules/holeToHole'
import { fillClearance } from './rules/fillClearance'
import { knockoutText } from './rules/knockoutText'
import { zones } from './rules/zones'
import { isolatedCopper } from './rules/isolatedCopper'
import { starvedThermal } from './rules/starvedThermal'
import { dangling } from './rules/dangling'
import { edge } from './rules/edge'
import { sizes } from './rules/sizes'
import { courtyardChecks } from './rules/courtyards'
import { itemsNotAllowed } from './rules/itemsNotAllowed'
import { unconnected } from './rules/unconnected'
import { texts } from './rules/texts'
import { trackGeometry } from './rules/trackGeometry'
import { postMachining } from './rules/postMachining'
import { physicalClearance } from './rules/physicalClearance'
import { footprints } from './rules/footprints'
import { misc } from './rules/misc'
import { silk } from './rules/silk'
import { solderMask } from './rules/solderMask'
import { connectionWidth } from './rules/connectionWidth'
import { copperSliver } from './rules/copperSliver'
import { signal } from './rules/signal'
import { diffPairGap } from './rules/diffPairGap'
import { creepage } from './rules/creepage'
import { libraryParity } from './rules/libraryParity'
import { schematicParity } from './rules/schematicParity'

export type RuleScope = 'region' | 'board'

/** The rule modules in the order they run: a later one may read what an earlier one flagged. */
export const BOARD_RULE_MODULES: ReadonlyArray<{
  name: string
  scope: RuleScope
  run: (ctx: DrcContext) => Generator<void> | void
}> = [
  { name: 'custom rules', scope: 'board', run: customRules },
  { name: 'copper clearance', scope: 'region', run: copperClearance },
  { name: 'hole clearance', scope: 'region', run: holeClearance },
  { name: 'drawing clearance', scope: 'region', run: drawingClearance },
  { name: 'hole to hole', scope: 'board', run: holeToHole },
  { name: 'fill clearance', scope: 'region', run: fillClearance },
  { name: 'knockout text', scope: 'board', run: knockoutText },
  { name: 'zones', scope: 'board', run: zones },
  { name: 'isolated copper', scope: 'board', run: isolatedCopper },
  { name: 'starved thermal', scope: 'board', run: starvedThermal },
  { name: 'dangling', scope: 'region', run: dangling },
  { name: 'edge', scope: 'board', run: edge },
  { name: 'sizes', scope: 'region', run: sizes },
  { name: 'courtyards', scope: 'region', run: courtyardChecks },
  { name: 'items not allowed', scope: 'board', run: itemsNotAllowed },
  { name: 'unconnected', scope: 'board', run: unconnected },
  { name: 'track geometry', scope: 'region', run: trackGeometry },
  { name: 'post-machining', scope: 'region', run: postMachining },
  { name: 'footprints', scope: 'board', run: footprints },
  { name: 'texts', scope: 'board', run: texts },
  { name: 'misc', scope: 'board', run: misc },
  { name: 'silk', scope: 'board', run: silk },
  { name: 'physical clearance', scope: 'board', run: physicalClearance },
  { name: 'solder mask', scope: 'board', run: solderMask },
  { name: 'signal', scope: 'board', run: signal },
  { name: 'diff pairs', scope: 'board', run: diffPairGap },
  { name: 'creepage', scope: 'board', run: creepage },
  { name: 'library parity', scope: 'board', run: libraryParity },
  { name: 'schematic parity', scope: 'board', run: schematicParity },
  { name: 'connection width', scope: 'board', run: connectionWidth },
  { name: 'copper sliver', scope: 'board', run: copperSliver }
]
