import { describe, expect, it } from 'vitest'
import { percent, shareAfter } from '../paneShares'

describe('shareAfter', () => {
  it('moves a share by the pixels dragged over the size divided', () => {
    expect(shareAfter(0.4, 100, 1000, 100, 100)).toBeCloseTo(0.5)
    expect(shareAfter(0.4, -100, 1000, 100, 100)).toBeCloseTo(0.3)
  })

  it('holds the pane at its minimum and leaves the other side what it keeps', () => {
    expect(shareAfter(0.4, -1000, 1000, 280, 420)).toBeCloseTo(0.28)
    expect(shareAfter(0.4, 1000, 1000, 280, 420)).toBeCloseTo(0.58)
  })

  it('changes nothing before the size is known', () => {
    expect(shareAfter(0.4, 50, 0, 10, 10)).toBe(0.4)
  })
})

describe('percent', () => {
  it('is a CSS percentage', () => {
    expect(percent(1 / 3)).toBe('33.333%')
  })
})
