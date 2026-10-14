import { describe, expect, it } from 'vitest'
import { collectCapped, newBudget, NAV_RESULT_CAP } from '../libraryNavSearch'

// Two library containers of small items; the matcher keeps items whose value
// contains the query letter.
const libs: Record<string, string[]> = {
  A: ['ax', 'ay', 'bz'],
  B: ['ax', 'cq']
}
const order = ['A', 'B']
const itemsOf = (k: string): string[] => libs[k] ?? []
const has =
  (q: string) =>
  (s: string): boolean =>
    s.includes(q)

describe('collectCapped', () => {
  it('groups matching items by container in order', () => {
    const groups = collectCapped(newBudget(), order, itemsOf, has('a'))
    expect([...groups.keys()]).toEqual(['A', 'B'])
    expect(groups.get('A')).toEqual(['ax', 'ay'])
    expect(groups.get('B')).toEqual(['ax'])
  })

  it('omits containers with no match', () => {
    const groups = collectCapped(newBudget(), order, itemsOf, has('c'))
    expect([...groups.keys()]).toEqual(['B'])
    expect(groups.get('B')).toEqual(['cq'])
  })

  it('stops at the budget and marks it capped, splitting mid-container', () => {
    const budget = newBudget(3)
    const groups = collectCapped(budget, order, itemsOf, () => true)
    // A contributes 3 (its whole set), budget hits 0 there; B is never reached.
    expect(groups.get('A')).toEqual(['ax', 'ay', 'bz'])
    expect(groups.has('B')).toBe(false)
    expect(budget.capped).toBe(true)
    expect(budget.remaining).toBe(0)
  })

  it('truncates within a container when the budget runs out partway', () => {
    const budget = newBudget(1)
    const groups = collectCapped(budget, order, itemsOf, () => true)
    expect(groups.get('A')).toEqual(['ax'])
    expect(budget.capped).toBe(true)
  })

  it('is not capped when everything fits', () => {
    const budget = newBudget(100)
    collectCapped(budget, order, itemsOf, () => true)
    expect(budget.capped).toBe(false)
  })

  it('shares one budget across several sections', () => {
    const budget = newBudget(2)
    const first = collectCapped(budget, ['A'], itemsOf, () => true)
    const second = collectCapped(budget, ['B'], itemsOf, () => true)
    expect(first.get('A')).toEqual(['ax', 'ay'])
    expect(second.size).toBe(0) // budget already spent by the first section
    expect(budget.capped).toBe(true)
  })

  it('defaults to the shared per-type cap', () => {
    expect(newBudget().remaining).toBe(NAV_RESULT_CAP)
  })
})
