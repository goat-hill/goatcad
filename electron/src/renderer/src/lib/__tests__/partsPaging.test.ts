import { describe, it, expect } from 'vitest'
import { PAGE_GAP, pageCount, pageRange, pageWindow } from '../partsPaging'

describe('pageCount', () => {
  it('counts partial pages', () => {
    expect(pageCount(892_356, 20)).toBe(44_618)
    expect(pageCount(41, 20)).toBe(3)
    expect(pageCount(40, 20)).toBe(2)
  })

  it('never reports fewer than one page', () => {
    expect(pageCount(0, 20)).toBe(1)
    expect(pageCount(5, 0)).toBe(1)
  })
})

describe('pageRange', () => {
  it('gives the 1-based span of a page', () => {
    expect(pageRange(0, 20, 892_356)).toEqual({ from: 1, to: 20 })
    expect(pageRange(2, 20, 892_356)).toEqual({ from: 41, to: 60 })
  })

  it('clamps the last page to the real total', () => {
    // Reading "…891–892,360 of 892,356" would be visibly wrong.
    expect(pageRange(2, 20, 45)).toEqual({ from: 41, to: 45 })
  })

  it('reports an empty span rather than negative numbers', () => {
    expect(pageRange(0, 20, 0)).toEqual({ from: 0, to: 0 })
    expect(pageRange(9, 20, 45)).toEqual({ from: 0, to: 0 })
  })
})

describe('pageWindow', () => {
  it('lists every page when they all fit', () => {
    expect(pageWindow(0, 1)).toEqual([0])
    expect(pageWindow(1, 3)).toEqual([0, 1, 2])
  })

  it('keeps first and last with a window around the current page', () => {
    expect(pageWindow(10, 40)).toEqual([0, PAGE_GAP, 9, 10, 11, PAGE_GAP, 39])
  })

  it('shows a single skipped page instead of hiding it behind an ellipsis', () => {
    // Replacing one page with "…" costs a click and saves nothing.
    expect(pageWindow(3, 8)).toEqual([0, 1, 2, 3, 4, PAGE_GAP, 7])
  })

  it('does not run off either end', () => {
    expect(pageWindow(0, 40)).toEqual([0, 1, PAGE_GAP, 39])
    expect(pageWindow(39, 40)).toEqual([0, PAGE_GAP, 38, 39])
  })

  it('never repeats a page', () => {
    const slots = pageWindow(1, 40)
    const numbers = slots.filter((slot): slot is number => slot !== PAGE_GAP)
    expect(new Set(numbers).size).toBe(numbers.length)
  })
})
