// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * A sheet's `(title_block …)`, read and written entry by entry as KiCad's
 * `TITLE_BLOCK::Format` (common/title_block.cpp) writes it: title, date, rev,
 * company, then `(comment N "…")` for 1–9, an empty entry left out and an
 * empty block not written at all.
 */
import type { KicadSchematic } from '../kicad/schematic'
import {
  findChild,
  getAtomValues,
  makeAtom,
  makeList,
  updateAtom,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'

/** The block's entries, in KiCad's order: `comment1` … `comment9` are its numbered comments. */
export const TITLE_BLOCK_KEYS = [
  'title',
  'date',
  'rev',
  'company',
  ...Array.from({ length: 9 }, (_, i) => `comment${i + 1}`)
] as const
export type TitleBlockKey = (typeof TITLE_BLOCK_KEYS)[number]

export const isTitleBlockKey = (key: string): key is TitleBlockKey =>
  (TITLE_BLOCK_KEYS as readonly string[]).includes(key)

const commentNumber = (key: TitleBlockKey): number | null =>
  key.startsWith('comment') ? Number(key.slice('comment'.length)) : null

/** The key an entry node is, or null for one this does not know. */
const keyOf = (node: SExprList): TitleBlockKey | null => {
  const head = node.children[0]
  const name = head?.type === 'atom' ? head.value : ''
  if (name === 'comment') {
    const key = `comment${getAtomValues(node)[0] ?? ''}`
    return isTitleBlockKey(key) ? key : null
  }
  return isTitleBlockKey(name) && !name.startsWith('comment') ? name : null
}

const entriesOf = (block: SExprList): SExprList[] =>
  block.children.filter((child): child is SExprList => child.type === 'list')

/** Every entry's text, empty for one the file does not give. */
export const readTitleBlock = (schematic: KicadSchematic): Record<TitleBlockKey, string> => {
  const values = Object.fromEntries(TITLE_BLOCK_KEYS.map((key) => [key, ''])) as Record<
    TitleBlockKey,
    string
  >
  const block = findChild(schematic._root, 'title_block')
  if (!block) return values
  for (const entry of entriesOf(block)) {
    const key = keyOf(entry)
    if (!key) continue
    const atoms = getAtomValues(entry)
    values[key] = (commentNumber(key) === null ? atoms[0] : atoms[1]) ?? ''
  }
  return values
}

/**
 * Set one entry. Empty text removes the entry, and the block with it when
 * nothing is left, as KiCad's writer would; a new entry goes in KiCad's order
 * among the ones there, and a new block after `(paper …)`, where KiCad writes
 * it. Every other entry is left as it is.
 */
export const setTitleBlockEntry = (
  schematic: KicadSchematic,
  key: TitleBlockKey,
  text: string
): void => {
  const root = schematic._root
  const at = root.start
  let block = findChild(root, 'title_block')
  const entries = block ? entriesOf(block) : []
  const existing = entries.find((entry) => keyOf(entry) === key)
  const number = commentNumber(key)
  if (text === '') {
    if (!block || !existing) return
    block.children.splice(block.children.indexOf(existing), 1)
    if (!block.children.some((child) => child.type === 'list'))
      root.children.splice(root.children.indexOf(block), 1)
    return
  }
  if (existing) {
    const atom = existing.children[number === null ? 1 : 2]
    if (atom?.type === 'atom') updateAtom(atom, text, true)
    else existing.children.push(makeAtom(text, true, at))
    return
  }
  if (!block) {
    block = makeList([makeAtom('title_block', false, at)], at)
    const anchor =
      findChild(root, 'paper') ?? findChild(root, 'uuid') ?? findChild(root, 'generator_version')
    root.children.splice(anchor ? root.children.indexOf(anchor) + 1 : 1, 0, block)
  }
  const atoms: SExprNode[] =
    number === null
      ? [makeAtom(key, false, at), makeAtom(text, true, at)]
      : [
          makeAtom('comment', false, at),
          makeAtom(String(number), false, at),
          makeAtom(text, true, at)
        ]
  const order = TITLE_BLOCK_KEYS.indexOf(key)
  // After the last entry KiCad writes before it, so one it does not know stays where it was.
  const before = entriesOf(block).filter((entry) => {
    const other = keyOf(entry)
    return other !== null && TITLE_BLOCK_KEYS.indexOf(other) < order
  })
  const anchor = before[before.length - 1]
  block.children.splice(anchor ? block.children.indexOf(anchor) + 1 : 1, 0, makeList(atoms, at))
}
