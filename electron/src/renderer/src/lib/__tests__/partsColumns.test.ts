import { describe, it, expect } from 'vitest'
import {
  FIXED_COLUMNS,
  SORT_LABEL_KEY,
  nextSort,
  parameterValue,
  parametricColumns,
  tableColumns
} from '../partsColumns'
import type { PartGroup, PartsFacets } from '../../../../preload/partsTypes'

const facets = (parametric: PartsFacets['parametric']): PartsFacets => ({
  manufacturers: [],
  packaging: [],
  status: [],
  series: [],
  parametric
})

const facet = (parameterId: number, name: string): PartsFacets['parametric'][number] => ({
  parameterId,
  name,
  values: []
})

/** One row with the given parameters, as a single-seller distributor result. */
const group = (mpn: string, parameters: { id: number | null; value: string }[]): PartGroup => ({
  key: mpn,
  mpn,
  manufacturer: 'ACME',
  description: 'a part',
  datasheetUrl: null,
  datasheetUrls: [],
  photoUrl: null,
  lifecycle: 'active',
  rohs: null,
  sources: [
    {
      provider: 'digikey',
      record: {
        provider: 'digikey',
        providerPartId: mpn,
        mpn,
        manufacturer: 'ACME',
        description: 'a part',
        datasheetUrl: null,
        photoUrl: null,
        productUrl: null,
        lifecycle: 'active',
        rohs: null,
        parameters: parameters.map((p) => ({
          name: `param-${p.id}`,
          value: p.value,
          parameterId: p.id
        })),
        offers: [],
        cad: { mode: 'none' },
        fetchedAt: 0
      }
    }
  ]
})

describe('FIXED_COLUMNS', () => {
  it('keeps the order PartsView writes its cells in', () => {
    // The template emits these <td>s explicitly, in this sequence. Reordering
    // the array without reordering the template puts every value under the
    // wrong heading, and nothing else would catch it.
    expect(FIXED_COLUMNS.map((column) => column.key)).toEqual([
      'part',
      'status',
      'seller',
      'stock',
      'price'
    ])
  })

  it('sorts the stacked part column by its part number', () => {
    // The cell stacks manufacturer and description too, but the heading stays
    // one line — a control per sortable line would be two rows of buttons over
    // a column that is already three rows of text.
    const part = FIXED_COLUMNS.find((column) => column.key === 'part')
    expect(part?.sorts).toEqual(['ManufacturerProductNumber'])
  })

  it('offers no sort where the API has no field for it', () => {
    // Seller is per-distributor and stacked; there is nothing to order by.
    expect(FIXED_COLUMNS.find((column) => column.key === 'seller')?.sorts).toEqual([])
  })

  it('names a label for every field the API accepts', () => {
    for (const column of FIXED_COLUMNS) {
      for (const field of column.sorts) expect(SORT_LABEL_KEY[field]).toBeTruthy()
    }
  })
})

describe('parameterValue', () => {
  it('joins on the id, not the display name', () => {
    const row = group('A', [{ id: 2049, value: '0.1 uF' }])
    expect(parameterValue(row, 2049)).toBe('0.1 uF')
    expect(parameterValue(row, 9999)).toBe('')
  })

  it('returns empty for a parameter the row reports without an id', () => {
    // Mouser publishes no ids at all, so its rows can never fill a column.
    expect(parameterValue(group('A', [{ id: null, value: '0402' }]), 2049)).toBe('')
  })
})

describe('parametricColumns', () => {
  const rows = [
    group('A', [
      { id: 2049, value: '0.1 uF' },
      { id: 16, value: '0402' }
    ]),
    group('B', [
      { id: 2049, value: '1 uF' },
      { id: 16, value: '0402' }
    ])
  ]

  it('offers nothing outside DigiKey mode, in either direction', () => {
    // Two catalogs' parameters cannot be merged without inventing a mapping.
    expect(parametricColumns('universal', facets([facet(2049, 'Capacitance')]), rows)).toEqual([])
    expect(parametricColumns('mouser', facets([facet(2049, 'Capacitance')]), rows)).toEqual([])
  })

  it('keeps a column whose values differ, in the order the distributor gave', () => {
    const columns = parametricColumns(
      'digikey',
      facets([facet(2049, 'Capacitance'), facet(3, 'Tolerance')]),
      rows
    )
    expect(columns.map((column) => column.key)).toEqual(['p:2049'])
    expect(columns[0]).toMatchObject({ label: 'Capacitance', parameterId: 2049 })
  })

  it('drops a column that reads the same all the way down', () => {
    // Package is 0402 on every row here: it costs width and separates nothing.
    // The value is still on each row's expanded detail.
    const columns = parametricColumns('digikey', facets([facet(16, 'Package / Case')]), rows)
    expect(columns).toEqual([])
  })

  it('drops a column no row reports', () => {
    expect(parametricColumns('digikey', facets([facet(777, 'Ripple Current')]), rows)).toEqual([])
  })

  it('never offers a sort, because the API rejects Parameter as a sort field', () => {
    const columns = parametricColumns('digikey', facets([facet(2049, 'Capacitance')]), rows)
    expect(columns.every((column) => column.sorts.length === 0)).toBe(true)
  })
})

describe('tableColumns', () => {
  it('puts identity before specifications', () => {
    const columns = tableColumns('digikey', facets([facet(2049, 'Capacitance')]), [
      group('A', [{ id: 2049, value: '1 uF' }]),
      group('B', [{ id: 2049, value: '2 uF' }])
    ])
    expect(columns.slice(0, FIXED_COLUMNS.length).map((c) => c.key)).toEqual(
      FIXED_COLUMNS.map((c) => c.key)
    )
    expect(columns.at(-1)?.key).toBe('p:2049')
  })
})

describe('nextSort', () => {
  it('cycles ascending, descending, then off', () => {
    expect(nextSort(null, 'Price')).toEqual({ field: 'Price', order: 'asc' })
    expect(nextSort({ field: 'Price', order: 'asc' }, 'Price')).toEqual({
      field: 'Price',
      order: 'desc'
    })
    // Off, not back to ascending: the enum has no relevance member, so the only
    // way to the distributor's own ordering is to send no sort at all.
    expect(nextSort({ field: 'Price', order: 'desc' }, 'Price')).toBeNull()
  })

  it('starts a different column ascending rather than inheriting a direction', () => {
    expect(nextSort({ field: 'Price', order: 'desc' }, 'Manufacturer')).toEqual({
      field: 'Manufacturer',
      order: 'asc'
    })
  })
})
