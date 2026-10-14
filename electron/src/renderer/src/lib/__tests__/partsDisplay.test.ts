import { describe, it, expect } from 'vitest'
import { priceAtQuantity, totalStock } from '../partsDisplay'
import type { PartRecord } from '../../../../preload/partsTypes'

const offer = (over: Partial<PartRecord['offers'][number]> = {}): PartRecord['offers'][number] => ({
  distributorPartNumber: 'X-ND',
  stock: null,
  moq: null,
  currency: 'USD',
  packaging: null,
  productUrl: null,
  priceBreaks: [],
  ...over
})

const record = (offers: PartRecord['offers']): PartRecord => ({
  provider: 'digikey',
  providerPartId: 'X-ND',
  mpn: 'X',
  manufacturer: 'Acme',
  description: '',
  datasheetUrl: null,
  photoUrl: null,
  productUrl: null,
  lifecycle: 'active',
  rohs: null,
  parameters: [],
  offers,
  cad: { mode: 'none' },
  fetchedAt: 0
})

describe('priceAtQuantity', () => {
  const breaks = record([
    {
      ...offer(),
      priceBreaks: [
        { quantity: 1, unitPrice: 3.5 },
        { quantity: 10, unitPrice: 3.1 },
        { quantity: 100, unitPrice: 2.5 }
      ]
    }
  ])

  it('applies the largest break at or below the target quantity', () => {
    // Buying 10 does not get you the 100-piece price.
    expect(priceAtQuantity(breaks, 10)).toMatchObject({ unitPrice: 3.1, breakQuantity: 10 })
    expect(priceAtQuantity(breaks, 50)).toMatchObject({ unitPrice: 3.1, breakQuantity: 10 })
    expect(priceAtQuantity(breaks, 100)).toMatchObject({ unitPrice: 2.5, breakQuantity: 100 })
    expect(priceAtQuantity(breaks, 1)).toMatchObject({ unitPrice: 3.5, breakQuantity: 1 })
  })

  it('returns null when nothing is buyable at that quantity', () => {
    // A part whose smallest order is 250 has no price at qty 10, and saying so
    // beats quoting a number nobody can buy at.
    const highMoq = record([{ ...offer(), priceBreaks: [{ quantity: 250, unitPrice: 1 }] }])
    expect(priceAtQuantity(highMoq, 10)).toBeNull()
  })

  it('returns null when the distributor quoted no price', () => {
    expect(priceAtQuantity(record([offer()]), 1)).toBeNull()
  })

  it('carries the currency the distributor quoted, never an assumed one', () => {
    const eur = record([
      { ...offer(), currency: 'EUR', priceBreaks: [{ quantity: 1, unitPrice: 2 }] }
    ])
    expect(priceAtQuantity(eur, 1)?.currency).toBe('EUR')
  })
})

describe('totalStock', () => {
  it("sums a distributor's packagings", () => {
    expect(totalStock(record([offer({ stock: 10 }), offer({ stock: 5 })]))).toBe(15)
  })

  it('separates "nobody said" from "none in stock"', () => {
    expect(totalStock(record([offer({ stock: null })]))).toBeNull()
    expect(totalStock(record([offer({ stock: 0 })]))).toBe(0)
  })
})
