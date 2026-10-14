import { describe, expect, test } from 'vitest'
import {
  dropOutcome,
  emptyRouteClick,
  escapeAction,
  routerMenuRows,
  type DropContext,
  type EscapeContext,
  type RouterMenuContext,
  type RouterMenuRow
} from '../routerGesture'

const ids = (rows: RouterMenuRow[]): string[] => rows.flatMap((r) => ('divider' in r ? [] : [r.id]))
const row = (rows: RouterMenuRow[], id: string): RouterMenuRow | undefined =>
  rows.find((r) => !('divider' in r) && r.id === id)
const disabled = (rows: RouterMenuRow[], id: string): boolean | undefined => {
  const r = row(rows, id)
  return r && !('divider' in r) ? (r.disabled ?? false) : undefined
}

const routing: RouterMenuContext = {
  gesture: 'route',
  started: true,
  clicked: true,
  hasOtherEnd: true
}

describe('R21: the router menu on right-click', () => {
  test("mid-route it holds KiCad's router items, Cancel first", () => {
    const rows = routerMenuRows(routing)
    expect(ids(rows)).toEqual([
      'cancel',
      'finish',
      'undoSegment',
      'routeFromOtherEnd',
      'attemptFinish',
      'viaThrough',
      'viaBlind',
      'viaMicro',
      'viaPickThrough',
      'viaPickBlind',
      'posture',
      'corner',
      'sizes',
      'mode'
    ])
    expect(rows.every((r) => 'divider' in r || !r.disabled)).toBe(true)
    // Each item names the key that does the same, so the menu teaches it.
    expect(row(rows, 'finish')).toMatchObject({ hotkey: 'pcb.endRoute' })
    expect(row(rows, 'attemptFinish')).toMatchObject({ hotkey: 'pcb.finishRoute' })
    expect(row(rows, 'cancel')).toMatchObject({ hotkey: 'editor.cancel' })
  })

  test('with the tool armed and no route, only what needs no route is offered', () => {
    const rows = routerMenuRows({ ...routing, started: false, clicked: false, hasOtherEnd: false })
    expect(ids(rows)).not.toContain('routeFromOtherEnd')
    expect(ids(rows)).not.toContain('attemptFinish')
    expect(disabled(rows, 'finish')).toBe(true)
    expect(disabled(rows, 'undoSegment')).toBe(true)
    expect(disabled(rows, 'posture')).toBe(true)
    expect(disabled(rows, 'viaBlind')).toBe(true)
    // V before a route arms a via for it (R37); sizes and mode always apply.
    expect(disabled(rows, 'viaThrough')).toBe(false)
    expect(disabled(rows, 'sizes')).toBe(false)
    expect(disabled(rows, 'mode')).toBe(false)
  })

  test('nothing clicked yet: no segment to undo', () => {
    expect(disabled(routerMenuRows({ ...routing, clicked: false }), 'undoSegment')).toBe(true)
  })

  test('a net already joined offers no finish to the other end (KiCad hasOtherEnd)', () => {
    const rows = routerMenuRows({ ...routing, hasOtherEnd: false })
    expect(ids(rows)).not.toContain('attemptFinish')
    expect(ids(rows)).not.toContain('routeFromOtherEnd')
  })

  test('PR6: a pair offers its dimensions in place of the size list', () => {
    const rows = routerMenuRows({ ...routing, gesture: 'pair' })
    expect(ids(rows)).toContain('pairDimensions')
    expect(ids(rows)).not.toContain('sizes')
    expect(ids(rows)[0]).toBe('cancel')
  })

  test('D9: a drag offers Cancel and Finish, never route items', () => {
    const rows = routerMenuRows({ ...routing, gesture: 'drag' })
    expect(ids(rows)).toEqual(['cancel', 'finish', 'corner', 'mode'])
  })

  test('T1: a tune offers Cancel', () => {
    const rows = routerMenuRows({ ...routing, gesture: 'tune' })
    expect(ids(rows)).toEqual(['cancel', 'finish', 'tuneSettings'])
  })

  test('no menu begins or ends with a divider, or doubles one', () => {
    for (const gesture of ['route', 'pair', 'drag', 'tune'] as const)
      for (const started of [true, false]) {
        const rows = routerMenuRows({ ...routing, gesture, started, hasOtherEnd: started })
        expect('divider' in rows[0]).toBe(false)
        expect('divider' in rows[rows.length - 1]).toBe(false)
        rows.forEach((r, i) => {
          if ('divider' in r) expect('divider' in rows[i + 1]).toBe(false)
        })
      }
  })
})

const none: EscapeContext = {
  drag: false,
  tune: false,
  pair: false,
  route: false,
  draft: false,
  toolArmed: false
}

describe('R21: Esc', () => {
  test('ends the route at once, armed via or not, keeping what is clicked', () => {
    expect(escapeAction({ ...none, route: true, toolArmed: true })).toBe('endRoute')
  })

  test('a gesture in hand ends before the route it runs inside', () => {
    expect(escapeAction({ ...none, drag: true, route: true })).toBe('endDrag')
    expect(escapeAction({ ...none, tune: true })).toBe('endTune')
    expect(escapeAction({ ...none, pair: true, toolArmed: true })).toBe('endPair')
  })

  test('with no route, the tool is put away; with no tool, the selection goes', () => {
    expect(escapeAction({ ...none, toolArmed: true })).toBe('putToolAway')
    expect(escapeAction({ ...none, draft: true, toolArmed: true })).toBe('clearDraft')
    expect(escapeAction(none)).toBe('clearSelection')
  })
})

describe("R21: a click with nothing to lay (KiCad's FixRoute of an empty line)", () => {
  test('does nothing: the route goes on', () => {
    expect(emptyRouteClick(false)).toBe('nothing')
  })

  test('with a via armed, the via is placed alone and the route ends', () => {
    expect(emptyRouteClick(true)).toBe('placeViaAndFinish')
  })
})

const drop: DropContext = {
  blocked: true,
  mode: 'shove',
  allowViolations: false,
  resolves: true,
  lastValid: true,
  commitAnyway: false,
  release: true
}

describe('D9: dropping a drag', () => {
  test('a legal drop lands, in every mode', () => {
    for (const mode of ['shove', 'walkaround', 'highlight'] as const)
      expect(dropOutcome({ ...drop, blocked: false, mode })).toBe('commit')
  })

  test('Highlight with Allow DRC violations lands a violating drop', () => {
    expect(dropOutcome({ ...drop, mode: 'highlight', allowViolations: true })).toBe('commit')
  })

  test("Push and Avoid land where the drag was last legal (KiCad's dragger)", () => {
    expect(dropOutcome(drop)).toBe('commitLastValid')
    expect(dropOutcome({ ...drop, mode: 'walkaround', release: false })).toBe('commitLastValid')
    // Ctrl changes nothing where a legal place exists.
    expect(dropOutcome({ ...drop, commitAnyway: true })).toBe('commitLastValid')
  })

  test('Highlight springs back on release and keeps dragging on a click', () => {
    expect(dropOutcome({ ...drop, mode: 'highlight' })).toBe('revert')
    expect(dropOutcome({ ...drop, mode: 'highlight', release: false })).toBe('stay')
  })

  test('Ctrl commits a Push or Avoid drag with no legal place, never a Highlight one', () => {
    // KiCad's commit of a drag that fell back to marking.
    expect(dropOutcome({ ...drop, lastValid: false, commitAnyway: true })).toBe('commit')
    expect(dropOutcome({ ...drop, lastValid: false })).toBe('revert')
    expect(dropOutcome({ ...drop, mode: 'highlight', commitAnyway: true })).toBe('revert')
  })

  test('D13, D15: a drag that neither pushes nor walks has no last legal place', () => {
    expect(dropOutcome({ ...drop, resolves: false, release: false })).toBe('stay')
    expect(dropOutcome({ ...drop, resolves: false, commitAnyway: true })).toBe('commit')
  })
})
