/**
 * The find every canvas editor shares (`shared/CanvasFindWidget.vue`): the
 * query's three switches, how a query matches, and the order hits are stepped
 * through. Each editor says which texts it offers (`FindCandidate`) and how to
 * show a hit; the schematic adds replace on top (`schematic/schematicFind.ts`).
 */
import { matchesHotkey } from './hotkeys'

export interface FindTextOptions {
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}

export const FIND_TEXT_DEFAULTS: FindTextOptions = {
  matchCase: false,
  wholeWord: false,
  regex: false
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The query as a global pattern, or null when empty or not a valid expression. */
export function compileQuery(query: string, options: FindTextOptions): RegExp | null {
  if (!query) return null
  let pattern = options.regex ? query : escapeRegExp(query)
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`
  try {
    return new RegExp(pattern, options.matchCase ? 'g' : 'gi')
  } catch {
    return null
  }
}

/** Every hit of `pattern` in `text`; an empty match never counts. */
export function hitsIn(text: string, pattern: RegExp): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = []
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1
      continue
    }
    hits.push({ start: match.index, end: match.index + match[0].length })
  }
  return hits
}

/** One text an editor offers to find, with what a hit on it selects. */
export interface FindCandidate<T> {
  /** Unique among the candidates, and the same for the same text next time. */
  key: string
  target: T
  text: string
  /** Where to look, in the editor's own coordinates; a net, say, has no one place. */
  position?: { x: number; y: number }
}

export interface FindHit<T> extends FindCandidate<T> {
  start: number
  end: number
}

/**
 * Every hit, in reading order — top to bottom, then left to right — with
 * `yDown` saying which way the editor's y runs; hits with no place follow in
 * the order given. A text is one entry per hit, each keyed apart so next and
 * previous step through them in turn.
 */
export function findHits<T>(
  candidates: readonly FindCandidate<T>[],
  query: string,
  options: FindTextOptions,
  yDown = true
): FindHit<T>[] {
  const pattern = compileQuery(query, options)
  if (!pattern) return []
  const hits: FindHit<T>[] = []
  for (const candidate of candidates) {
    for (const hit of hitsIn(candidate.text, pattern)) {
      hits.push({ ...candidate, key: `${candidate.key}|${hit.start}`, ...hit })
    }
  }
  const down = yDown ? 1 : -1
  return hits.sort((a, b) => {
    if (!a.position || !b.position) return (a.position ? 0 : 1) - (b.position ? 0 : 1)
    return down * (a.position.y - b.position.y) || a.position.x - b.position.x || a.start - b.start
  })
}

/** The hit a step lands on: the next or previous one, wrapping; the first step from none. */
export function steppedHit(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return (current + delta + count) % count
}

/** The step Find Next / Previous asks for (F3, Shift+F3; ⌘G, ⌘⇧G on macOS), or null. */
export const findStepFor = (event: KeyboardEvent): 1 | -1 | null =>
  matchesHotkey(event, 'editor.findNext')
    ? 1
    : matchesHotkey(event, 'editor.findPrevious')
      ? -1
      : null
