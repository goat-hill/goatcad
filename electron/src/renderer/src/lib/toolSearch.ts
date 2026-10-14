import type { IconName } from './icons'
import { tk, type MessageKey } from './messageKey'
import type { TransformOp } from './schematic/schematicTransform'

/**
 * The toolbar tool search's catalog shape, shared by every editor
 * (shared/ToolbarSearch.vue). Each editor lists every control on its canvas
 * toolbars — the top bar and the left view rail — tagged with one of the
 * groups below, and the dropdown lays them out the same way everywhere:
 * an Edit section and a View section, each split into titled groups.
 */

/**
 * Every group, in the order the dropdown shows them, mapped to its section.
 * One vocabulary for all editors: a group an editor has no ops for is simply
 * absent, so the same kind of control sits under the same heading in each.
 */
export const TOOL_SEARCH_GROUPS = {
  select: 'edit', // the select tool, acting on the selection
  place: 'edit', // parts and pins: symbols, power, pads, sheets
  connect: 'edit', // electrical: wires, labels, tracks, vias
  routeOptions: 'edit', // how the router behaves
  draw: 'edit', // graphic shapes and text
  zones: 'edit',
  units: 'edit', // a multi-unit symbol's gates
  utilities: 'edit', // whole-document operations (annotate)
  navigate: 'view', // where the camera looks: zoom to fit
  display: 'view', // how items draw: sketch modes, fills, overlays
  layers: 'view' // which layers show, and from which side
} as const

export type ToolSearchGroup = keyof typeof TOOL_SEARCH_GROUPS
export type ToolSearchSection = (typeof TOOL_SEARCH_GROUPS)[ToolSearchGroup]

export interface ToolbarSearchOp {
  id: string
  icon: IconName
  /** Already-translated display name (the editor owns its i18n namespace). */
  label: string
  group: ToolSearchGroup
  hotkey?: string
  /**
   * Mirrors the toolbar chip (DESIGN.md "A selected tool is copper; an on
   * toggle is lit"): `current` for the armed tool, `on` for a lit view toggle.
   */
  state?: 'current' | 'on'
  disabled?: boolean
}

/** The id every editor's fit chip and search row share (`data-tool-op`). */
export const FIT_VIEW_OP_ID = 'fitView'

/**
 * Zoom to fit, the first control on every view rail. `label` is the shared
 * name (`shared.insertSearch.ops.fitView`), translated by the caller.
 */
export const fitViewOp = (label: string, hotkey: string): ToolbarSearchOp => ({
  id: FIT_VIEW_OP_ID,
  icon: 'tool-fit',
  label,
  group: 'navigate',
  hotkey
})

/**
 * Rotate and mirror, the chips after History on the schematic and symbol
 * editors' bars, in toolbar order. Each editor binds its own hotkeys.
 */
export const TRANSFORM_TOOLS: ReadonlyArray<{
  op: TransformOp
  icon: IconName
  label: MessageKey
}> = [
  { op: 'rotateCCW', icon: 'tool-rotate-ccw', label: tk('shared.insertSearch.ops.rotateCCW') },
  { op: 'rotateCW', icon: 'tool-rotate-cw', label: tk('shared.insertSearch.ops.rotateCW') },
  {
    op: 'mirrorHorizontal',
    icon: 'tool-mirror-horizontal',
    label: tk('shared.insertSearch.ops.mirrorHorizontal')
  },
  {
    op: 'mirrorVertical',
    icon: 'tool-mirror-vertical',
    label: tk('shared.insertSearch.ops.mirrorVertical')
  }
]

export const isTransformOp = (id: string): id is TransformOp =>
  TRANSFORM_TOOLS.some((tool) => tool.op === id)

export interface ToolSearchGroupLayout {
  group: ToolSearchGroup
  /** `index` is the op's position in keyboard order across the whole dropdown. */
  ops: Array<{ op: ToolbarSearchOp; index: number }>
}

export interface ToolSearchSectionLayout {
  section: ToolSearchSection
  columns: ToolSearchGroupLayout[][]
}

export interface ToolSearchLayout {
  sections: ToolSearchSectionLayout[]
  /** Every op in keyboard order: down each column, then across. */
  ops: ToolbarSearchOp[]
  /** Keyboard index of each group's first op, in order. */
  groupStarts: number[]
}

/**
 * How tall a column may grow before the next group starts a new one, counted
 * in rows with a group's heading as one, when the space below the toolbar is
 * unknown. Columns rather than scrolling, so the whole catalog is on screen.
 */
export const TOOL_SEARCH_COLUMN_ROWS = 10

// Heights in shared/ToolbarSearch.vue's CSS, rounded up so a column never
// overshoots: an op row (26px glyph box + 8px padding + 2px gap), and the
// section's fixed overhead (its padding, title and the dropdown's border).
const ROW_PX = 36
const SECTION_CHROME_PX = 40
const MIN_COLUMN_ROWS = 4

/**
 * The tallest column that fits in `heightPx` of canvas below the dropdown's
 * top. Columns grow down before the dropdown grows right, so it spreads
 * across the canvas only as far as the height forces it to.
 */
export const toolSearchRowsFor = (heightPx: number): number =>
  Math.max(MIN_COLUMN_ROWS, Math.floor((heightPx - SECTION_CHROME_PX) / ROW_PX))

export const filterToolSearchOps = (ops: ToolbarSearchOp[], query: string): ToolbarSearchOp[] => {
  const needle = query.trim().toLowerCase()
  if (!needle) return ops
  return ops.filter((op) => op.label.toLowerCase().includes(needle))
}

/**
 * Groups `ops` into sections → columns → groups. Groups keep the registry
 * order, ops their given order within a group; a group never splits across
 * columns, and a column takes the next group while it fits in `maxRows`.
 */
export const layoutToolSearch = (
  ops: ToolbarSearchOp[],
  maxRows = TOOL_SEARCH_COLUMN_ROWS
): ToolSearchLayout => {
  const byGroup = new Map<ToolSearchGroup, ToolbarSearchOp[]>()
  for (const op of ops) {
    const list = byGroup.get(op.group)
    if (list) list.push(op)
    else byGroup.set(op.group, [op])
  }

  const sections: ToolSearchSectionLayout[] = []
  const ordered: ToolbarSearchOp[] = []
  const groupStarts: number[] = []
  for (const group of Object.keys(TOOL_SEARCH_GROUPS) as ToolSearchGroup[]) {
    const groupOps = byGroup.get(group)
    if (!groupOps) continue
    const section = TOOL_SEARCH_GROUPS[group]
    let sectionLayout = sections[sections.length - 1]
    if (sectionLayout?.section !== section) {
      sectionLayout = { section, columns: [] }
      sections.push(sectionLayout)
    }
    const rows = groupOps.length + 1
    const column = sectionLayout.columns[sectionLayout.columns.length - 1]
    const used = column?.reduce((sum, g) => sum + g.ops.length + 1, 0) ?? Infinity
    const layout: ToolSearchGroupLayout = { group, ops: [] }
    if (used + rows <= maxRows) column.push(layout)
    else sectionLayout.columns.push([layout])
    groupStarts.push(ordered.length)
    for (const op of groupOps) {
      layout.ops.push({ op, index: ordered.length })
      ordered.push(op)
    }
  }
  return { sections, ops: ordered, groupStarts }
}
