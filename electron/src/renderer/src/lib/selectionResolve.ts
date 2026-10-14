/** Select the most-specific permitted hit level; each editor supplies its policy. */

/**
 * One thing the cursor is over, described from the inside out.
 *
 * `levels` is the containment chain, MOST SPECIFIC FIRST: a symbol's pin
 * arrives as `[pin, symbol]`, a bare wire as `[wire]`. Things that contain
 * nothing and are contained by nothing — most of the PCB — carry one level and
 * resolve through this untouched.
 */
export interface HitCandidate<T> {
  levels: Array<HitLevel<T>>
}

export interface HitLevel<T> {
  /** What the editor's policy switches on: 'pin', 'field', 'wire', 'symbol'. */
  kind: string
  /**
   * Whether the document marks this item locked. Not a kind — an item has a
   * kind AND a lock state, and the two are filtered independently — so it rides
   * on the level rather than being folded into `kind`.
   */
  locked?: boolean
  /** What the editor selects if this level wins. */
  ref: T
}

/**
 * Whether an editor lets a click land on this level. This is where the
 * selection filter plugs in — a filtered-out kind is one the editor stops
 * allowing, and needs no separate machinery.
 *
 * It takes the whole level rather than just `kind` because the filter asks two
 * independent questions of one item ("is this kind allowed" and "is this lock
 * state allowed"), and only the level carries both.
 */
export type AllowsHit = (level: { kind: string; locked?: boolean }) => boolean

/**
 * The selection for a click, given everything under the cursor.
 *
 * `candidates` must arrive in the order the scene ranks them, best first —
 * each scene keeps its own ranking (the board weighs distance then render z;
 * the schematic prefers small items to symbol bodies), because those rules
 * encode real differences between the documents and are not this function's
 * business.
 *
 * A candidate whose WHOLE chain is disallowed falls through to the next
 * candidate rather than selecting nothing. That is what makes filtering useful:
 * with symbols filtered out, clicking a symbol lying over a wire should give
 * you the wire, not an empty selection. Returning null on the first miss would
 * turn a filter into a way of making clicks stop working.
 */
export function resolveHit<T>(candidates: Array<HitCandidate<T>>, allows: AllowsHit): T | null {
  for (const candidate of candidates) {
    for (const level of candidate.levels) {
      if (allows(level)) return level.ref
    }
  }
  return null
}

/**
 * Everything a box sweep takes, resolved by the same rule.
 *
 * Applying the policy to a rubber band as well as to a click is most of the
 * filter's value, and KiCad does the same. Duplicates are dropped by `key`
 * because several parts of one symbol resolving up to that symbol must select
 * it once, not once per part.
 */
export function resolveSweep<T>(
  candidates: Array<HitCandidate<T>>,
  allows: AllowsHit,
  key: (ref: T) => string
): T[] {
  const picked: T[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const ref = resolveHit([candidate], allows)
    if (ref === null) continue
    const id = key(ref)
    if (seen.has(id)) continue
    seen.add(id)
    picked.push(ref)
  }
  return picked
}

/**
 * The kinds each editor lets a click land on.
 *
 * These reproduce today's behavior exactly, which is the point: the machinery
 * lands first and every change to what is selectable is then a visible edit to
 * this table rather than a change in behavior smuggled in with the plumbing.
 *
 * The asymmetries are real and deliberate, not oversights:
 *
 * - **A schematic click never lands inside a symbol** except on its field text.
 *   Pins have names so the renderer can highlight one and netlist sync can
 *   refer to one; being named and being selectable are different capabilities.
 *   Moving a Reference is a thing people genuinely do, so field text is the one
 *   exception.
 * - **The symbol editor is the inside of a symbol**, so there is no symbol level
 *   to resolve up to — every part stands for itself.
 *
 * A kind here is what the *user* filters, which is coarser than the item type a
 * scene reports: the board's `segment` and `tarc` are both "track", its five
 * `gr_*` shapes are all "graphic", and a keepout zone is a "rule_area"
 * (`boardItemKind`, BoardScene.ts; `footprintItemKind`, FootprintScene.ts). Every kind listed must be one some
 * scene actually produces — an unreachable entry would show up in the filter
 * panel as a checkbox that does nothing.
 */
export const SELECTABLE_KINDS: Record<string, readonly string[]> = {
  schematic: [
    'field',
    'symbol',
    'wire',
    'label',
    'junction',
    'no_connect',
    'sheet',
    'sheet_pin',
    'text',
    'graphic',
    'image',
    'rule_area'
  ],
  symbol: ['pin', 'graphic', 'field'],
  // A pad is selectable on the board, as in KiCad: its own properties edit, and
  // move, rotate, flip and copy act on its footprint (`promotePads`).
  pcb: ['footprint', 'pad', 'track', 'via', 'zone', 'rule_area', 'graphic', 'text', 'point'],
  footprint: ['pad', 'graphic', 'zone', 'text', 'point']
}

/**
 * The filter kind of a schematic item type — coarser, as KiCad's filter is: a
 * bus and a bus entry are wires, a directive label is a label, a text box and
 * a table are text, and the five free shapes are graphics. A sheet's name and
 * file text are fields, as a symbol's Reference is.
 */
export const schematicItemKind = (type: string): string => {
  switch (type) {
    case 'bus':
    case 'bus_entry':
      return 'wire'
    case 'netclass_flag':
      return 'label'
    case 'text_box':
    case 'table':
      return 'text'
    case 'shape':
    case 'polyline':
    case 'circle':
    case 'arc':
    case 'bezier':
      return 'graphic'
    case 'sheet_field':
      return 'field'
    default:
      return type
  }
}

/**
 * `AllowsHit` for one editor, from the table above — what the editor is capable
 * of selecting, before the user's filter narrows it further
 * (`allowsHitFor` in `selectionFilter.ts` composes the two).
 */
export function allowsKindFor(editor: keyof typeof SELECTABLE_KINDS | string): AllowsHit {
  const kinds = SELECTABLE_KINDS[editor]
  // An editor with no entry allows everything: a viewport that has not opted
  // into the model must not silently stop selecting.
  if (!kinds) return () => true
  const set = new Set(kinds)
  return (level) => set.has(level.kind)
}
